# Scope Shape — Feature 2: Claude adapter + agent toggles

(v0.1 shape preserved in git history at this path.)

## Problem & audience
Two asks: (1) the hub cannot delegate to Claude Code — the most-used agent CLI is missing; (2) all wrapped agents are always exposed — users who only have some CLIs installed (or want to prevent, e.g., recursive claude-in-claude calls) can't turn agents off; disabled-but-exposed tools waste client tool-selection attention.

## Chosen mode: Reduction
Smallest valuable slice: one new pure adapter + one env-var allowlist, mirroring existing patterns exactly.

## Smallest valuable version
- `claude` adapter (`claude -p`, prompt via stdin — same injection-safe shape as codex/cursor), registered fourth.
- `MCP_AGENTS` env var: comma-separated allowlist (e.g. `MCP_AGENTS=codex,claude`); unset/empty → all agents. Unknown name → fail fast at startup with the valid list. Applied identically to stdio and HTTP entries; consistent with the existing `MCP_TOKEN`/`MCP_ALLOWED_ORIGINS` naming.
- Docker image installs the claude CLI; compose passes `MCP_AGENTS` + `ANTHROPIC_API_KEY` through; README updated.

## Explicitly NOT building
- Per-agent config beyond on/off (default models, per-agent timeouts) — backlog.
- Config file support (env only).
- Runtime toggling via an MCP tool (restart to change).
- A separate deny-list variable (one mechanism: allowlist).

## 10/10 vs 5/10
10/10 = disabled agents vanish from `listTools`/`list_agents`/`run_all`, invalid config fails loudly at startup, claude adapter injection-safe and covered by the same test patterns as the other three. 5/10 = claude bolted on with toggles that only hide tools but still fan out in `run_all`.

## Riskiest assumption
Exact `claude -p` stdin/flag behavior and the npm package/auth story for the Docker image — being verified by a research subagent before the gate.
