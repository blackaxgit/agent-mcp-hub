import type { AgentAdapter, AgentInvocation, AgentRunOptions } from "../types.js";

export const cursorAdapter: AgentAdapter = {
  name: "cursor",
  summary:
    "Cursor Agent (cursor-agent) — Cursor's repo-aware autonomous coding agent; implements and edits code from a natural-language task.",
  binary: "cursor-agent",
  loginCommand: "cursor-agent login",
  apiKeyEnv: "CURSOR_API_KEY",
  buildInvocation(prompt: string, options: AgentRunOptions = {}): AgentInvocation {
    const args = ["-p", "--output-format", "text"];
    if (options.model) args.push("--model", options.model);
    // No positional prompt: cursor-agent reads it from piped stdin in print mode.
    return { args, stdin: prompt };
  },
};
