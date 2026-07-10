import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runCommand, type Exec, type ExecResult, OutputLimitError } from "./exec.js";
import {
  confirmEnabled,
  buildConfirmMessage,
  buildRunAllMessage,
  CONFIRM_SCHEMA,
  CANCEL_TAIL,
} from "./confirm.js";
import { classifyFailure } from "./failure.js";
import { isGitRepo, worktreeDirty, captureChange } from "./git.js";
import { checkAvailability, resolveOnPath, type ResolveBinary } from "./registry.js";
import type { ElicitRequestFormParams } from "@modelcontextprotocol/sdk/types.js";
import type { AgentAdapter } from "./types.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

/**
 * Single execution path for every agent tool: build the invocation, run it, and
 * emit one structured audit line to stderr (never stdout — C5). Both the
 * per-agent tools and run_all funnel through here so exec-path behavior stays in
 * one place.
 */
async function runAdapter(
  adapter: AgentAdapter,
  exec: Exec,
  params: {
    prompt: string;
    model?: string;
    cwd?: string;
    timeoutMs?: number;
    idleTimeoutMs?: number;
  },
  onActivity?: () => void,
): Promise<ExecResult> {
  const invocation = adapter.buildInvocation(params.prompt, { model: params.model });
  const start = Date.now();
  const audit = (exitCode: number | null | undefined) =>
    console.error(
      JSON.stringify({
        evt: "agent_run",
        agent: adapter.name,
        cwd: params.cwd ?? null,
        ms: Date.now() - start,
        exitCode,
      }),
    );
  try {
    const result = await exec(adapter.binary, invocation.args, {
      cwd: params.cwd,
      timeoutMs: params.timeoutMs,
      idleTimeoutMs: params.idleTimeoutMs,
      input: invocation.stdin,
      onActivity,
    });
    audit(result.exitCode);
    return result;
  } catch (err) {
    audit(undefined);
    throw err;
  }
}

/**
 * The slice of the tool handler's `extra` arg we touch for progress: the request
 * `_meta.progressToken` (present only when the client asked for out-of-band
 * progress) and `sendNotification`. Kept structural so the SDK's richer extra
 * object assigns straight in without importing its generic handler type.
 */
interface ProgressExtra {
  _meta?: { progressToken?: string | number };
  sendNotification: (notification: {
    method: "notifications/progress";
    params: { progressToken: string | number; progress: number; message?: string };
  }) => Promise<void>;
}

/**
 * Build the SYNC activity callback that emits MCP progress for one request, or
 * `undefined` when the client did not attach a progressToken (behave as today).
 * The returned closure is fire-and-forget: it NEVER awaits `sendNotification` (a
 * child 'data' handler must not await) and swallows any send rejection.
 *
 * Throttle: a leading-edge send fires on the first activity (lastSentSec starts
 * at -Infinity), then at most one send per ~10s window. `progress` is forced
 * strictly increasing (Math.max(lastProgress + 1, elapsedSec)) so a shared
 * emitter — including run_all's concurrent adapters — never repeats a value.
 */
function makeProgressEmitter(
  extra: ProgressExtra | undefined,
  label: string,
): (() => void) | undefined {
  const progressToken = extra?._meta?.progressToken;
  if (progressToken === undefined) return undefined;
  const start = Date.now();
  let lastSentSec = -Infinity;
  let lastProgress = 0;
  return () => {
    const elapsedSec = Math.floor((Date.now() - start) / 1000);
    if (elapsedSec - lastSentSec < 10) return;
    lastSentSec = elapsedSec;
    const progress = Math.max(lastProgress + 1, elapsedSec);
    lastProgress = progress;
    void extra!
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress, message: `${label} running… ${elapsedSec}s` },
      })
      .catch(() => {});
  };
}

const agentInputSchema = {
  prompt: z.string().describe("The task or question for the agent, in natural language."),
  model: z
    .string()
    .optional()
    .describe(
      'Optional model id passed through to the CLI, overriding that CLI\'s configured/default model (e.g. "o3"). Model names are agent-specific.',
    ),
  cwd: z
    .string()
    .optional()
    .describe(
      "Working directory for the CLI. Prefer an absolute path; a relative path resolves from the server process's cwd. Not a sandbox — the agent may read/edit any files it can access.",
    ),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Total runtime cap in milliseconds — the hard upper bound on the whole run once the CLI starts (excludes time queued behind the concurrency limit); the process group is killed if exceeded (default 1800000 = 30 minutes).",
    ),
  idleTimeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Idle/inactivity timeout in milliseconds — the run is killed only if the agent produces NO output for this long (the timer resets on each output chunk; default 300000 = 5 minutes).",
    ),
};

export function buildServer(
  adapters: AgentAdapter[],
  exec: Exec = runCommand,
  // Injected alongside exec so list_agents stays testable without depending on
  // which CLIs happen to be installed on the machine running the tests.
  resolve: ResolveBinary = resolveOnPath,
): McpServer {
  const server = new McpServer({ name: "agent-mcp-hub", version });

  /**
   * Confirm-before-run gate (MCP elicitation). Returns true to proceed. Degrades
   * to true (run-as-today) when disabled or the client lacks FORM elicitation —
   * keyed ONLY on the standard protocol capability, never a product name (E7).
   */
  async function confirmOrCancel(summary: string): Promise<boolean> {
    if (!confirmEnabled()) return true;
    const caps = server.server.getClientCapabilities();
    // Guard on .form: the SDK normalizes a client's elicitation:{} to {form:{}};
    // clients that do not advertise it lack the capability and must degrade.
    if (caps?.elicitation?.form === undefined) return true;
    try {
      const params: ElicitRequestFormParams = {
        mode: "form",
        message: summary,
        requestedSchema: CONFIRM_SCHEMA,
      };
      const r = await server.server.elicitInput(params);
      return r.action === "accept" && r.content?.confirm === true;
    } catch {
      return false;
    }
  }

  server.registerTool(
    "ping",
    {
      description: 'Liveness check for agent-mcp-hub — returns "pong". Read-only, no side effects.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => ({ content: [{ type: "text", text: "pong" }] }),
  );

  server.registerTool(
    "list_agents",
    {
      description:
        "List the wrapped coding-agent CLIs and whether each can actually run (edits nothing). " +
        "Each entry reports `installed` (binary resolves on PATH with the exec bit) and `usable` " +
        "(a probe succeeded), plus a `reason` when it cannot run; `available` mirrors `usable`. " +
        "A CLI can be installed but unusable — codex exits 0 from `--version` even when its home " +
        "is unwritable and no real run can succeed — so prefer `usable`. Read-only; call this " +
        "first to choose an agent before delegating.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const statuses = await Promise.all(adapters.map((a) => checkAvailability(a, exec, resolve)));
      return { content: [{ type: "text", text: JSON.stringify(statuses, null, 2) }] };
    },
  );

  for (const adapter of adapters) {
    server.registerTool(
      adapter.name,
      {
        description: `${adapter.summary} Runs the \`${adapter.binary}\` CLI non-interactively in \`cwd\` — it can read and edit files there and may take time or use the agent's own model quota — and returns its output. On common failures returns a classified, actionable error (not installed / not authenticated with the exact login command / not configured / timed out / busy / output-limit); other non-zero exits return a clipped stderr/stdout tail. Check availability with list_agents first.`,
        inputSchema: agentInputSchema,
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      async ({ prompt, model, cwd, timeoutMs, idleTimeoutMs }, extra) => {
        if (!(await confirmOrCancel(buildConfirmMessage(adapter.name, { prompt, model, cwd })))) {
          return {
            isError: true,
            content: [{ type: "text", text: `${adapter.name}: ${CANCEL_TAIL}` }],
          };
        }
        try {
          const onActivity = makeProgressEmitter(extra, adapter.name);
          const result = await runAdapter(
            adapter,
            exec,
            { prompt, model, cwd, timeoutMs, idleTimeoutMs },
            onActivity,
          );
          if (result.exitCode !== 0) {
            const { message } = classifyFailure(adapter, { result });
            return { isError: true, content: [{ type: "text", text: message }] };
          }
          return { content: [{ type: "text", text: result.stdout.trim() }] };
        } catch (err) {
          const { message } = classifyFailure(adapter, { error: err });
          return { isError: true, content: [{ type: "text", text: message }] };
        }
      },
    );
  }

  server.registerTool(
    "run_all",
    {
      description:
        "Fan the SAME prompt out to every enabled agent concurrently and return each agent's answer, labelled per agent — for comparing agents or cross-checking a result. Spawns every CLI (each can read/edit files in `cwd`) so it can be slow or use several agents' quotas; one confirmation covers the whole batch.",
      inputSchema: {
        prompt: z
          .string()
          .describe("The task or question to send to every agent, in natural language."),
        model: z
          .string()
          .optional()
          .describe(
            "Optional model id override passed through to each agent CLI. Names are agent-specific.",
          ),
        cwd: z
          .string()
          .optional()
          .describe(
            "Working directory for every CLI. Prefer an absolute path; a relative path resolves from the server process's cwd. Not a sandbox.",
          ),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Per-agent TOTAL runtime cap in milliseconds once each CLI starts (process group killed if exceeded; default 1800000 = 30 minutes).",
          ),
        idleTimeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Per-agent idle/inactivity timeout in milliseconds — killed only if the agent produces NO output for this long (resets on each output chunk; default 300000 = 5 minutes).",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ prompt, model, cwd, timeoutMs, idleTimeoutMs }, extra) => {
      if (
        !(await confirmOrCancel(
          buildRunAllMessage(
            adapters.map((a) => a.name),
            { prompt, cwd },
          ),
        ))
      ) {
        return { isError: true, content: [{ type: "text", text: `run_all: ${CANCEL_TAIL}` }] };
      }
      // One shared emitter for the whole batch: a single progressToken and a
      // single monotonic counter, so 4 concurrent adapters cannot emit colliding
      // progress values.
      const onActivity = makeProgressEmitter(extra, "run_all");
      const settled = await Promise.allSettled(
        adapters.map((adapter) =>
          runAdapter(adapter, exec, { prompt, model, cwd, timeoutMs, idleTimeoutMs }, onActivity),
        ),
      );
      const content = settled.map((outcome, i) => {
        const adapter = adapters[i];
        const name = adapter.name;
        if (outcome.status === "rejected") {
          const { message } = classifyFailure(adapter, { error: outcome.reason });
          return { type: "text" as const, text: `## ${name} (failed)\n${message}` };
        }
        if (outcome.value.exitCode === 0) {
          return { type: "text" as const, text: `## ${name} (ok)\n${outcome.value.stdout.trim()}` };
        }
        const { message } = classifyFailure(adapter, { result: outcome.value });
        return { type: "text" as const, text: `## ${name} (failed)\n${message}` };
      });
      return { content };
    },
  );

  server.registerTool(
    "review_change",
    {
      description:
        "Run the `runner` agent in `cwd` (which edits files), capture the concrete `git diff` of the change, then have the `reviewer` agent judge it and return a PASS/WARN/FAIL verdict along with the runner output, the diff, and the review. Requires a git worktree. Newly-created (untracked) files are reviewed by name only (their contents are not in the diff). The diff may include pre-existing changes if the worktree was already dirty.",
      inputSchema: {
        runner: z.string().describe("Adapter name of the agent that edits files"),
        reviewer: z.string().describe("Adapter name of the agent that judges the change"),
        prompt: z.string().describe("Task or question to send to the runner agent"),
        cwd: z.string().describe("Git working tree the runner operates in (REQUIRED)"),
        model: z.string().optional().describe("Model override passed to both agents"),
        timeoutMs: z.number().int().positive().optional().describe("Per-agent timeout in ms"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ runner, reviewer, prompt, cwd, model, timeoutMs }) => {
      const runnerAdapter = adapters.find((a) => a.name === runner);
      const reviewerAdapter = adapters.find((a) => a.name === reviewer);
      if (!runnerAdapter || !reviewerAdapter) {
        const valid = adapters.map((a) => a.name).join(", ");
        const missing: string[] = [];
        if (!runnerAdapter) missing.push(runner);
        if (!reviewerAdapter) missing.push(reviewer);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `unknown agent "${missing.join(", ")}"; valid: ${valid}`,
            },
          ],
        };
      }

      if (
        !(await confirmOrCancel(
          `review_change: run ${runner} in ${cwd}, then review with ${reviewer}\nprompt: ${prompt}`,
        ))
      ) {
        return {
          isError: true,
          content: [{ type: "text", text: `review_change: ${CANCEL_TAIL}` }],
        };
      }

      let isRepo: boolean;
      try {
        isRepo = await isGitRepo(exec, cwd);
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `review_change: git failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
      if (!isRepo) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `cwd is not a git repository (or \`git\` is not on PATH): ${cwd}`,
            },
          ],
        };
      }

      let wasDirty: boolean;
      try {
        wasDirty = await worktreeDirty(exec, cwd);
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `review_change: git failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }

      let runnerResult: ExecResult;
      try {
        runnerResult = await runAdapter(runnerAdapter, exec, { prompt, model, cwd, timeoutMs });
      } catch (err) {
        const { message } = classifyFailure(runnerAdapter, { error: err });
        return { isError: true, content: [{ type: "text", text: message }] };
      }
      if (runnerResult.exitCode !== 0) {
        const { message } = classifyFailure(runnerAdapter, { result: runnerResult });
        return { isError: true, content: [{ type: "text", text: message }] };
      }

      let change;
      try {
        change = await captureChange(exec, cwd);
      } catch (err) {
        const base = `## ${runner} output\n${runnerResult.stdout.trim()}\n\n`;
        if (err instanceof OutputLimitError) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text:
                  base +
                  "The diff is too large to review (exceeded the output limit); review skipped.",
              },
            ],
          };
        }
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                base +
                `git failed capturing the diff: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }

      if (change.diff.trim() === "" && change.untracked.length === 0) {
        let text = `## ${runner} output\n${runnerResult.stdout.trim()}\n\nNo file changes detected; review skipped.`;
        if (wasDirty) {
          text =
            "⚠ worktree was already dirty; the diff may include pre-existing changes.\n\n" + text;
        }
        return { isError: false, content: [{ type: "text", text }] };
      }

      const untrackedLine =
        change.untracked.length > 0
          ? `New untracked files: ${change.untracked.join(", ")}`
          : "New untracked files: (none)";
      const diffText = change.diff.trim() === "" ? "(no tracked diff)" : change.diff;
      const reviewPrompt = [
        `Task: ${prompt}`,
        `Runner output:`,
        runnerResult.stdout.trim(),
        `Diff:`,
        diffText,
        untrackedLine,
        "Respond with EXACTLY one of PASS, WARN, or FAIL on the FIRST line, then your findings.",
      ].join("\n");

      let reviewResult: ExecResult;
      try {
        reviewResult = await runAdapter(reviewerAdapter, exec, {
          prompt: reviewPrompt,
          model,
          cwd,
          timeoutMs,
        });
      } catch (err) {
        const statSection =
          change.stat.trim() === "" ? "" : `## Change (git diff --stat)\n${change.stat}`;
        const untrackedNote =
          change.untracked.length > 0 ? `\nNew files: ${change.untracked.join(", ")}` : "";
        const { message } = classifyFailure(reviewerAdapter, { error: err });
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `## ${runner} output\n${runnerResult.stdout.trim()}\n\n${statSection}${untrackedNote}\n\nReview could not run: ${message}`,
            },
          ],
        };
      }
      if (reviewResult.exitCode !== 0) {
        const statSection =
          change.stat.trim() === "" ? "" : `## Change (git diff --stat)\n${change.stat}`;
        const untrackedNote =
          change.untracked.length > 0 ? `\nNew files: ${change.untracked.join(", ")}` : "";
        const { message } = classifyFailure(reviewerAdapter, { result: reviewResult });
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `## ${runner} output\n${runnerResult.stdout.trim()}\n\n${statSection}${untrackedNote}\n\nReview could not run: ${message}`,
            },
          ],
        };
      }

      const firstLine = reviewResult.stdout
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.length > 0);
      const verdict = /^(PASS|WARN|FAIL)\b/i.exec(firstLine ?? "")?.[1].toUpperCase() ?? "WARN";

      const lines: string[] = [];
      if (wasDirty) {
        lines.push("⚠ worktree was already dirty; the diff may include pre-existing changes.");
      }
      lines.push(
        `## ${runner} output\n${runnerResult.stdout.trim()}`,
        `## Change (git diff --stat)\n${change.stat}`,
      );
      if (change.untracked.length > 0) {
        lines.push(`New files: ${change.untracked.join(", ")}`);
      }
      lines.push(`## Review by ${reviewer} — ${verdict}\n${reviewResult.stdout.trim()}`);

      return { isError: false, content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  return server;
}
