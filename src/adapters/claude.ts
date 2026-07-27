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
      // Verified live: with this list the Write/Edit/Bash tools are absent from the
      // session entirely, while normal verdict output is unaffected.
      //
      // GLUED (`--disallowedTools=<list>`) on purpose: the flag is variadic
      // (`<tools...>`), so as a separate token it greedily consumes following
      // non-flag argv entries — observed swallowing a positional prompt and
      // killing the run. Gluing makes correctness a property of OUR argv rather
      // than of argument order.
      //
      // Every name here must be a REAL tool: an unknown one only prints
      // `Permission deny rule "X" matches no known tool` and silently protects
      // nothing. `MultiEdit` was in this list and does not exist in current
      // Claude Code — do not re-add a name without checking for that warning.
      args.push("--disallowedTools=Write,Edit,NotebookEdit,Bash");
    }
    if (options.model) args.push("--model", options.model);
    // No positional prompt: claude reads it from piped stdin in print mode.
    return { args, stdin: prompt };
  },
};
