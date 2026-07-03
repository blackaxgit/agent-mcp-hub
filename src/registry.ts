import { codexAdapter } from "./adapters/codex.js";
import { cursorAdapter } from "./adapters/cursor.js";
import { opencodeAdapter } from "./adapters/opencode.js";
import type { Exec } from "./exec.js";
import type { AgentAdapter } from "./types.js";

export function allAdapters(): AgentAdapter[] {
  return [codexAdapter, cursorAdapter, opencodeAdapter];
}

export async function checkAvailability(adapter: AgentAdapter, exec: Exec): Promise<boolean> {
  try {
    const result = await exec(adapter.binary, ["--version"], { timeoutMs: 10_000 });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}
