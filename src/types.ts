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
  /** Pure function: prompt + options -> invocation. No I/O allowed here. */
  buildInvocation(prompt: string, options?: AgentRunOptions): AgentInvocation;
}
