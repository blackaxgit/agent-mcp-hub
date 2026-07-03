import { claudeAdapter } from "./adapters/claude.js";
import { codexAdapter } from "./adapters/codex.js";
import { cursorAdapter } from "./adapters/cursor.js";
import { opencodeAdapter } from "./adapters/opencode.js";
import type { Exec } from "./exec.js";
import type { AgentAdapter } from "./types.js";

export function allAdapters(): AgentAdapter[] {
  return [codexAdapter, cursorAdapter, opencodeAdapter, claudeAdapter];
}

/**
 * Selects which adapters to expose based on MCP_AGENTS (comma-separated,
 * whitespace-tolerant, case-sensitive). Unset or empty-after-parse yields all
 * adapters (never an empty server). Unknown names fail fast with an actionable
 * message so typos are surfaced at wiring time rather than silently dropped.
 */
export function enabledAdapters(agentsSpec = process.env.MCP_AGENTS): AgentAdapter[] {
  const requested = [
    ...new Set(
      (agentsSpec ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ];
  if (requested.length === 0) return allAdapters();
  const known = new Set(allAdapters().map((a) => a.name));
  for (const name of requested) {
    if (!known.has(name)) {
      throw new Error(
        `Unknown agent "${name}" in MCP_AGENTS. Valid agents: ${allAdapters()
          .map((a) => a.name)
          .join(", ")}`,
      );
    }
  }
  const set = new Set(requested);
  return allAdapters().filter((a) => set.has(a.name));
}

export async function checkAvailability(adapter: AgentAdapter, exec: Exec): Promise<boolean> {
  try {
    const result = await exec(adapter.binary, ["--version"], { timeoutMs: 10_000 });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}
