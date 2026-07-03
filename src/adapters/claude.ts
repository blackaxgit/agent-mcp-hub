import type { AgentAdapter, AgentInvocation, AgentRunOptions } from "../types.js";

export const claudeAdapter: AgentAdapter = {
  name: "claude",
  binary: "claude",
  buildInvocation(prompt: string, options: AgentRunOptions = {}): AgentInvocation {
    const args = ["-p", "--output-format", "text"];
    if (options.model) args.push("--model", options.model);
    // No positional prompt: claude reads it from piped stdin in print mode.
    return { args, stdin: prompt };
  },
};
