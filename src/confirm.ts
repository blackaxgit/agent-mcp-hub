// Pure helpers for the confirm-before-run gate (MCP elicitation).
// No I/O, no subprocesses — safe to import anywhere and trivially testable.

const ENABLING = new Set(["1", "true", "on", "all"]);

/** True iff MCP_CONFIRM (case-/whitespace-insensitive) is one of 1, true, on, all. */
export function confirmEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.MCP_CONFIRM;
  if (raw === undefined) return false;
  return ENABLING.has(raw.trim().toLowerCase());
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
  opts: { prompt: string; cwd?: string },
): string {
  const lines = [
    `Run all agents (${agentNames.join(", ")})?`,
    `prompt: ${truncate(opts.prompt, PROMPT_MAX)}`,
  ];
  if (opts.cwd !== undefined) lines.push(`cwd: ${opts.cwd}`);
  return lines.join("\n");
}

/** requestedSchema for elicitInput: a single required boolean the client renders. */
export const CONFIRM_SCHEMA = {
  type: "object",
  properties: {
    confirm: {
      type: "boolean",
      title: "Run this agent?",
      description: "Confirm to run; decline to cancel.",
    },
  },
  required: ["confirm"],
} as const;

/** Canonical terminal cancel wording shared by both call sites (asserted in tests). */
export const CANCEL_TAIL =
  "run cancelled by user — nothing was executed. Do not retry unless the user asks.";
