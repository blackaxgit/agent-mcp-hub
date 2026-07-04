import type { AgentAdapter, AgentInvocation, AgentRunOptions } from "../types.js";

export const opencodeAdapter: AgentAdapter = {
  name: "opencode",
  binary: "opencode",
  loginCommand: "opencode auth login",
  buildInvocation(prompt: string, options: AgentRunOptions = {}): AgentInvocation {
    if (prompt.startsWith("-")) {
      // opencode documents neither stdin input nor a "--" delimiter, so a
      // dash-leading prompt could be parsed as a flag by its CLI.
      throw new Error(
        "opencode cannot safely run prompts that start with '-' (its CLI may parse them as flags). Rephrase the prompt to start with a word, e.g. \"explain --help ...\".",
      );
    }
    const args = ["run"];
    if (options.model) args.push("--model", options.model);
    args.push(prompt);
    return { args };
  },
};
