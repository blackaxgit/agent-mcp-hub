export interface AgentRunOptions {
  model?: string;
}

export interface AgentInvocation {
  /** argv passed to the binary (no shell involved). */
  args: string[];
  /** When set, the executor must pipe this to the child's stdin. */
  stdin?: string;
}

export interface AgentAdapter {
  /** Tool name exposed over MCP, e.g. "codex". */
  readonly name: string;
  /** Executable looked up on PATH, e.g. "cursor-agent". */
  readonly binary: string;
  /** Command the user runs to authenticate this CLI, e.g. "codex login". */
  readonly loginCommand: string;
  /** Env var carrying an API key fallback, when the CLI supports one. */
  readonly apiKeyEnv?: string;
  /** Pure function: prompt + options -> invocation. No I/O allowed here. */
  buildInvocation(prompt: string, options?: AgentRunOptions): AgentInvocation;
}
