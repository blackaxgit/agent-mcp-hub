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
  prompt: z.string().describe("The task or question to send to the agent"),
  model: z.string().optional().describe("Model override passed to the agent CLI"),
  cwd: z.string().optional().describe("Working directory for the agent process"),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Total runtime cap: kill the agent after this many ms overall (default 1800000)"),
  idleTimeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Idle/inactivity timeout in ms: the run is killed only if the agent produces NO output for this long (default 300000)",
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
      description: "Send the same prompt to every wrapped agent in parallel and return all answers",
      inputSchema: {
        prompt: z.string().describe("The task or question to send to all agents"),
        model: z.string().optional().describe("Model override passed to every agent CLI"),
        cwd: z.string().optional().describe("Working directory for the agent processes"),
        timeoutMs: z.number().int().positive().optional().describe("Per-agent timeout in ms"),
        idleTimeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Idle/inactivity timeout in ms: the run is killed only if the agent produces NO output for this long (default 300000)",
          ),
      },
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

  return server;
}
