import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runCommand, type Exec, type ExecResult } from "./exec.js";
import { checkAvailability } from "./registry.js";
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
        try {
          const result = await runAdapter(adapter, exec, { prompt, model, cwd, timeoutMs });
          if (result.exitCode !== 0) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `${adapter.name} failed (exit ${result.exitCode}):\n${result.stderr || result.stdout}`,
                },
              ],
            };
          }
          return { content: [{ type: "text", text: result.stdout.trim() }] };
        } catch (err) {
          return {
            isError: true,
            content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          };
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
      const settled = await Promise.allSettled(
        adapters.map((adapter) => runAdapter(adapter, exec, { prompt, model, cwd, timeoutMs })),
      );
      const content = settled.map((outcome, i) => {
        const name = adapters[i].name;
        if (outcome.status === "rejected") {
          const msg =
            outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
          return { type: "text" as const, text: `## ${name} (failed)\n${msg}` };
        }
        const { stdout, stderr, exitCode } = outcome.value;
        return exitCode === 0
          ? { type: "text" as const, text: `## ${name} (ok)\n${stdout.trim()}` }
          : {
              type: "text" as const,
              text: `## ${name} (failed)\nexit ${exitCode}: ${stderr || stdout}`,
            };
      });
      return { content };
    },
  );

  return server;
}
