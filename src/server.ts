import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runCommand, type Exec, type ExecResult } from "./exec.js";
import {
  confirmEnabled,
  buildConfirmMessage,
  buildRunAllMessage,
  CONFIRM_SCHEMA,
  CANCEL_TAIL,
} from "./confirm.js";
import { classifyFailure } from "./failure.js";
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
      "Hard timeout in milliseconds for the CLI once it starts (excludes time queued behind the concurrency limit); the process group is killed if exceeded (default 300000 = 5 minutes).",
    ),
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
        "List the wrapped coding-agent CLIs and whether each is installed on PATH (probes each with `--version`; edits nothing). Read-only — call this first to choose an available agent before delegating.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
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
        description: `${adapter.summary} Runs the \`${adapter.binary}\` CLI non-interactively in \`cwd\` — it can read and edit files there and may take time or use the agent's own model quota — and returns its output. On common failures returns a classified, actionable error (not installed / not authenticated with the exact login command / not configured / timed out / busy / output-limit); other non-zero exits return a clipped stderr/stdout tail. Check availability with list_agents first.`,
        inputSchema: agentInputSchema,
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
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
            "Per-agent hard timeout in milliseconds once each CLI starts (process group killed if exceeded; default 300000).",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
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

  return server;
}
