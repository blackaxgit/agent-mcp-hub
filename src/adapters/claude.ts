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
    if (options.model) args.push("--model", options.model);
    // No positional prompt: claude reads it from piped stdin in print mode.
    return { args, stdin: prompt };
  },
};
