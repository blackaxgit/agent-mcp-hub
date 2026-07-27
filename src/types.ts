/**
 * How much the agent is allowed to do on this run.
 *
 * - `"write"` — the agent may edit files and run commands in `cwd`. The default.
 * - `"read-only"` — the agent should only read and answer. Used by the
 *   `review_change` REVIEWER, whose prompt embeds an attacker-controlled diff
 *   and which only needs to return a verdict.
 *
 * **Enforcement differs per CLI and must not be overstated.** Only `codex`
 * (`--sandbox`, OS-level) and `claude` (deny rules, harness-level) genuinely
 * restrict the agent. `cursor --mode plan` is model-advisory; `agy` simply has
 * its permission grant withheld, which makes headless runs auto-deny write and
 * command tools — narrowing, not a sandbox; and `opencode` has no CLI lever at
 * all, so for it `read-only` is a documented no-op. Table in AGENTS.md.
 */
export type PermissionMode = "read-only" | "write";

export interface AgentRunOptions {
  model?: string;
  /** Defaults to `"write"` when undefined, so existing call sites are unchanged. */
  permissionMode?: PermissionMode;
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
  /** One line identifying the agent and when to reach for it; front of the MCP
   *  tool description so a client can pick between the agents. */
  readonly summary: string;
  /** Executable looked up on PATH, e.g. "cursor-agent". */
  readonly binary: string;
  /** Command the user runs to authenticate this CLI, e.g. "codex login". */
  readonly loginCommand: string;
  /** Env var carrying an API key fallback, when the CLI supports one. */
  readonly apiKeyEnv?: string;
  /**
   * Args for the availability probe. Defaults to ["--version"], which proves only
   * that the binary starts — codex exits 0 from `--version` even when its home is
   * unwritable and no real run can succeed. Prefer a command whose OUTPUT proves
   * the CLI can work. There is no single such command across the CLIs: `opencode
   * models` lists models, while `codex models` is not a subcommand at all.
   */
  readonly probeArgs?: string[];
  /**
   * When true, the probe must emit at least one identifier-shaped line, not merely
   * exit 0 — a CLI can exit 0 while printing a banner or a "not logged in" notice.
   */
  readonly probeRequiresOutput?: boolean;
  /** Pure function: prompt + options -> invocation. No I/O allowed here. */
  buildInvocation(prompt: string, options?: AgentRunOptions): AgentInvocation;
  /**
   * Line patterns the CLI prints on its DIAGNOSTIC stream (stderr) when it cannot reach its
   * backend. Matched against stderr ONLY: the model's answer arrives on stdout, so a model
   * that quotes one of these phrases can never trip the detector.
   */
  readonly stallSignatures?: readonly RegExp[];
}
