import type { AgentAdapter, AgentInvocation, AgentRunOptions } from "../types.js";

export const cursorAdapter: AgentAdapter = {
  name: "cursor",
  binary: "cursor-agent",
  buildInvocation(prompt: string, options: AgentRunOptions = {}): AgentInvocation {
    const args = ["-p", "--output-format", "text"];
    if (options.model) args.push("--model", options.model);
    // No positional prompt: cursor-agent reads it from piped stdin in print mode.
    return { args, stdin: prompt };
  },
};
