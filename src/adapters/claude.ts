import type { AgentAdapter, AgentInvocation, AgentRunOptions } from "../types.js";

export const claudeAdapter: AgentAdapter = {
  name: "claude",
  summary:
    "Claude Code — Anthropic's coding agent for complex implementation, refactoring, and code review.",
  binary: "claude",
  loginCommand: "claude  (then /login)",
  apiKeyEnv: "ANTHROPIC_API_KEY",
  buildInvocation(prompt: string, options: AgentRunOptions = {}): AgentInvocation {
    const args = ["-p", "--output-format", "text"];
    if (options.permissionMode === "read-only") {
      // Deny rules are evaluated BEFORE the tool runs and hold in every permission
      // mode, so this is a genuine harness-level restriction rather than advice —
      // the strongest read-only lever of the five after codex's OS sandbox.
      // Passed as ONE comma-separated token on purpose: the flag is variadic
      // (`<tools...>`), so separate argv tokens could greedily swallow a following
      // flag. Claude's own help documents "Comma or space-separated".
      args.push("--disallowedTools", "Write,Edit,MultiEdit,NotebookEdit,Bash");
    }
    if (options.model) args.push("--model", options.model);
    // No positional prompt: claude reads it from piped stdin in print mode.
    return { args, stdin: prompt };
  },
};
