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
    // LOAD-BEARING. `codex exec` defaults to a **read-only** sandbox, so without
    // an explicit `-s` this tool silently reported success while writing nothing
    // — verified live: it answered "DONE" and created no file anywhere on disk.
    // `workspace-write` is the least-privilege setting that still delivers what
    // the tool description promises. `--dangerously-bypass-approvals-and-sandbox`
    // is deliberately NEVER emitted: it nullifies `--sandbox` entirely.
    // Emitted BEFORE the "-" sentinel so the prompt is never taken positionally.
    args.push("-s", options.permissionMode === "read-only" ? "read-only" : "workspace-write");
    // "-" = read the prompt from stdin (documented Codex CLI sentinel).
    args.push("-");
    return { args, stdin: prompt };
  },
};
