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
import { checkAvailability } from "./registry.js";
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
  params: { prompt: string; model?: string; cwd?: string; timeoutMs?: number },
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
      input: invocation.stdin,
    });
    audit(result.exitCode);
    return result;
  } catch (err) {
    audit(undefined);
    throw err;
  }
}

const agentInputSchema = {
  prompt: z.string().describe("The task or question to send to the agent"),
  model: z.string().optional().describe("Model override passed to the agent CLI"),
  cwd: z.string().optional().describe("Working directory for the agent process"),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Kill the agent after this many ms (default 300000)"),
};

export function buildServer(adapters: AgentAdapter[], exec: Exec = runCommand): McpServer {
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
    // URL-only / stateless-HTTP / non-elicit clients lack it and must degrade.
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
    { description: "Health check for agent-mcp-hub", inputSchema: {} },
    async () => ({ content: [{ type: "text", text: "pong" }] }),
  );

  server.registerTool(
    "list_agents",
    { description: "List wrapped CLI agents and whether each is installed", inputSchema: {} },
    async () => {
      const statuses = await Promise.all(
        adapters.map(async (a) => ({ name: a.name, available: await checkAvailability(a, exec) })),
      );
      return { content: [{ type: "text", text: JSON.stringify(statuses, null, 2) }] };
    },
  );

  for (const adapter of adapters) {
    server.registerTool(
      adapter.name,
      {
        description: `Delegate a prompt to the ${adapter.name} CLI agent (non-interactive) and return its output`,
        inputSchema: agentInputSchema,
      },
      async ({ prompt, model, cwd, timeoutMs }) => {
        if (!(await confirmOrCancel(buildConfirmMessage(adapter.name, { prompt, model, cwd })))) {
          return {
            isError: true,
            content: [{ type: "text", text: `${adapter.name}: ${CANCEL_TAIL}` }],
          };
        }
        try {
          const result = await runAdapter(adapter, exec, { prompt, model, cwd, timeoutMs });
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
      description: "Send the same prompt to every wrapped agent in parallel and return all answers",
      inputSchema: {
        prompt: z.string().describe("The task or question to send to all agents"),
        model: z.string().optional().describe("Model override passed to every agent CLI"),
        cwd: z.string().optional().describe("Working directory for the agent processes"),
        timeoutMs: z.number().int().positive().optional().describe("Per-agent timeout in ms"),
      },
    },
    async ({ prompt, model, cwd, timeoutMs }) => {
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
      const settled = await Promise.allSettled(
        adapters.map((adapter) => runAdapter(adapter, exec, { prompt, model, cwd, timeoutMs })),
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
        "Run an agent in a git worktree, capture the diff, and have a second agent judge the change (PASS/WARN/FAIL)",
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
