import type { AgentAdapter, AgentInvocation, AgentRunOptions } from "../types.js";

export const codexAdapter: AgentAdapter = {
  name: "codex",
  binary: "codex",
  buildInvocation(prompt: string, options: AgentRunOptions = {}): AgentInvocation {
    const args = ["exec", "--skip-git-repo-check"];
    if (options.model) args.push("--model", options.model);
    // "-" = read the prompt from stdin (documented Codex CLI sentinel).
    args.push("-");
    return { args, stdin: prompt };
  },
};
