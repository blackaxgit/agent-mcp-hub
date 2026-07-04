import type { AgentAdapter, AgentInvocation, AgentRunOptions } from "../types.js";

export const codexAdapter: AgentAdapter = {
  name: "codex",
  summary:
    "OpenAI Codex — a terminal coding agent (GPT/o-series) that autonomously reads and edits files to implement, refactor, and fix code.",
  binary: "codex",
  loginCommand: "codex login",
  apiKeyEnv: "OPENAI_API_KEY",
  buildInvocation(prompt: string, options: AgentRunOptions = {}): AgentInvocation {
    const args = ["exec", "--skip-git-repo-check"];
    if (options.model) args.push("--model", options.model);
    // "-" = read the prompt from stdin (documented Codex CLI sentinel).
    args.push("-");
    return { args, stdin: prompt };
  },
};
