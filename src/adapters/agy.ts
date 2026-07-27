import type { AgentAdapter, AgentInvocation, AgentRunOptions } from "../types.js";

/**
 * Cap agy applies to its OWN print-mode run. Deliberately ABOVE `MAX_TIMEOUT_MS`
 * (24h, `exec.ts`) so agy's internal timer can never fire before the hub's total/
 * idle timers — the hub stays the single source of timeout truth, exactly as for
 * the other four agents.
 *
 * This flag is load-bearing: `--print-timeout` defaults to **5 minutes**, so
 * without it agy silently kills every longer run with an opaque
 * `Error: timeout waiting for response` (exit 1) no matter what `timeoutMs` the
 * caller asked for — making this tool's documented timeout a lie for this agent.
 */
const PRINT_TIMEOUT = "48h";

export const agyAdapter: AgentAdapter = {
  name: "agy",
  summary:
    "Google Antigravity (agy) — Gemini-powered autonomous coding agent that reads and edits files to implement, refactor, and fix code.",
  binary: "agy",
  // agy has NO `login` subcommand: it authenticates on first interactive run and
  // stores credentials in the OS keyring. There is therefore no API-key env var,
  // so `apiKeyEnv` stays undefined — which also means every OTHER agent's key is
  // stripped from its environment (see `credentialStripKeys`), same as opencode.
  loginCommand: "agy  (then sign in when prompted)",
  // `agy models` prints bare model ids ("gemini-3.1-pro-high"), one per line, and
  // exercises account eligibility rather than merely starting the binary — the
  // same reasoning that makes `opencode models` a better probe than `--version`.
  probeArgs: ["models"],
  probeRequiresOutput: true,
  buildInvocation(prompt: string, options: AgentRunOptions = {}): AgentInvocation {
    // `--new-project` is LOAD-BEARING. Without it agy ignores the process working
    // directory entirely and runs in ~/.gemini/antigravity-cli/scratch, so the
    // hub's `cwd` contract would silently not hold for this agent and it would
    // edit files somewhere the caller never named. Verified against agy 1.1.7.
    const args = ["--new-project", "--print-timeout", PRINT_TIMEOUT];
    // Headless agy cannot prompt for tool permission, so it auto-DENIES and then
    // exits 0 with EMPTY stdout — a failure that reads as success. Auto-approving
    // is what lets agy actually read and edit files (cursor's `--force` plays the
    // same role). Withheld only when the run is JUDGING attacker-controlled
    // content — the `review_change` reviewer passes `permissionMode: "read-only"`.
    // `--sandbox` is NEVER emitted: upstream #36 reports that combining it with
    // the skip flag lets the agent auto-approve its own sandbox escape, and alone
    // it does not produce a usable read-only mode.
    if (options.permissionMode !== "read-only") args.push("--dangerously-skip-permissions");
    if (options.model) args.push("--model", options.model);
    // The prompt is the GLUED value of `--print`. Glued (`--print=x`) rather than
    // `-p x` on purpose: the value is physically part of a single argv token, so
    // it can never be re-parsed as a flag regardless of how agy's flag library
    // treats a dash-leading value now or in a future release. That makes the
    // dash-prompt guarantee a property of OUR argv, not of a third-party parser —
    // which is why this adapter needs no opencode-style dash-guard.
    // No stdin: agy takes the prompt here, not on stdin.
    args.push(`--print=${prompt}`);
    return { args };
  },
};
