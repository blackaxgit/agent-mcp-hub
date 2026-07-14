// Pure helpers for the confirm-before-run gate (MCP elicitation).
// No I/O, no subprocesses — safe to import anywhere and trivially testable.
import type { ElicitRequestFormParams } from "@modelcontextprotocol/sdk/types.js";

const ENABLING = new Set(["1", "true", "on", "all"]);

/**
 * The confirm gate has three modes:
 *  - `"off"`   — MCP_CONFIRM unset/other → run without a gate (default).
 *  - `"on"`    — MCP_CONFIRM in {1,true,on,all} → ask; DEGRADE OPEN (run with a
 *    warning) if the client cannot show a form.
 *  - `"strict"`— MCP_CONFIRM=strict → ask; FAIL CLOSED (refuse to run) if the
 *    client cannot show a form. For operators who need "no run without a human".
 */
export type ConfirmMode = "off" | "on" | "strict";

export function confirmMode(env: NodeJS.ProcessEnv = process.env): ConfirmMode {
  const raw = env.MCP_CONFIRM?.trim().toLowerCase();
  if (raw === undefined) return "off";
  if (raw === "strict") return "strict";
  return ENABLING.has(raw) ? "on" : "off";
}

/** True iff the confirm gate is active in any mode (`on` or `strict`). */
export function confirmEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return confirmMode(env) !== "off";
}

/**
 * Truncate `input` so the RESULT length is `<= max`, counting the ellipsis
 * marker (…, U+2026). Inputs already within `max` are returned unchanged.
 */
export function truncate(input: string, max: number): string {
  if (max < 1) return "";
  if (input.length <= max) return input;
  return input.slice(0, max - 1) + "…";
}

const PROMPT_MAX = 300;

/** Short human summary naming the agent, with cwd/model lines only when present. */
export function buildConfirmMessage(
  agentName: string,
  opts: { prompt: string; model?: string; cwd?: string },
): string {
  const lines = [`Run agent "${agentName}"?`, `prompt: ${truncate(opts.prompt, PROMPT_MAX)}`];
  if (opts.cwd !== undefined) lines.push(`cwd: ${opts.cwd}`);
  if (opts.model !== undefined) lines.push(`model: ${opts.model}`);
  return lines.join("\n");
}

/** Summary listing every enabled agent name for a single run_all confirmation. */
export function buildRunAllMessage(
  agentNames: string[],
  opts: { prompt: string; cwd?: string; model?: string },
): string {
  const lines = [
    `Run all agents (${agentNames.join(", ")})?`,
    `prompt: ${truncate(opts.prompt, PROMPT_MAX)}`,
  ];
  if (opts.cwd !== undefined) lines.push(`cwd: ${opts.cwd}`);
  // `model` is shown so a caller sees exactly what is forwarded to each CLI —
  // it is attacker-influenceable and must not be hidden from the human gate.
  if (opts.model !== undefined) lines.push(`model: ${opts.model}`);
  return lines.join("\n");
}

/** requestedSchema for elicitInput: a single required boolean the client renders.
 *  Typed against the SDK so a malformed edit fails typecheck (drift-safe). The
 *  import is type-only — erased at runtime, so this module stays pure. */
export const CONFIRM_SCHEMA: ElicitRequestFormParams["requestedSchema"] = {
  type: "object",
  properties: {
    confirm: {
      type: "boolean",
      title: "Run this agent?",
      description: "Confirm to run; decline to cancel.",
    },
  },
  required: ["confirm"],
};

/** Canonical terminal cancel wording shared by both call sites (asserted in tests). */
export const CANCEL_TAIL =
  "run cancelled by user — nothing was executed. Do not retry unless the user asks.";
