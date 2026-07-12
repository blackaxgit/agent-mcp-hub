import type { AgentAdapter, AgentInvocation, AgentRunOptions } from "../types.js";

export const cursorAdapter: AgentAdapter = {
  name: "cursor",
  summary:
    "Cursor Agent (cursor-agent) — Cursor's repo-aware autonomous coding agent; implements and edits code from a natural-language task.",
  binary: "cursor-agent",
  loginCommand: "cursor-agent login",
  apiKeyEnv: "CURSOR_API_KEY",
  // `cursor-agent models` requires a valid account, so exit 0 proves authentication
  // — far stronger than `--version`. probeRequiresOutput stays false on purpose: it
  // prints prose ("gpt-5.3-codex-low - Codex 5.3 Low"), not bare ids, so the
  // identifier heuristic would find nothing and condemn a healthy CLI.
  probeArgs: ["models"],
  // Line-anchored on purpose: a loose /retry attempt \d+/i would also match that
  // phrase appearing mid-line in output from a build script the agent runs.
  stallSignatures: [
    /^connection lost, reconnecting to \S+ \(attempt \d+\)\.*$/i,
    /^retry attempt \d+\.*$/i,
    /^retriable\s*error:\s*connection stalled\b/i,
  ],
  buildInvocation(prompt: string, options: AgentRunOptions = {}): AgentInvocation {
    // --force: cursor-agent otherwise blocks on an interactive permission prompt
    // ("Workspace Trust Required" / command approval) in any directory it has not
    // seen before, which for a server invoked against arbitrary cwds is most of
    // them. There is no stdin to answer it with in print mode, so the run would
    // hang until the timeout kills it. (`--trust` is NOT a cursor-agent flag —
    // passing it makes the CLI exit 1 with "unknown option '--trust'".)
    const args = ["-p", "--output-format", "text", "--force"];
    if (options.model) args.push("--model", options.model);
    // No positional prompt: cursor-agent reads it from piped stdin in print mode.
    return { args, stdin: prompt };
  },
};
