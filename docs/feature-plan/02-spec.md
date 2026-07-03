# Feature Spec — Feature 2: Claude adapter + agent enable/disable

(v0.1 spec preserved in git history; its F/C/A numbering continues to hold for shipped behavior. This spec covers the delta.)

## Requirements (functional)
1. G1 — New `claude` agent tool wrapping the Claude Code CLI: adapter `name: "claude"`, `binary: "claude"`, non-interactive print mode with the prompt delivered via stdin (injection-safe like codex/cursor); `model` option maps to `--model`. Exact argv per research (01-approach.md).
2. G2 — Registry order becomes `[claude, codex, cursor, opencode]`… **correction:** append to preserve existing order: `[codex, cursor, opencode, claude]` (stable order matters to `list_agents`/`run_all` tests and users).
3. G3 — `MCP_AGENTS` env var (comma-separated, whitespace-tolerant, case-sensitive names) selects which agents are exposed. Unset or empty → all four. Applied at startup (stdio entry) / server-build (HTTP): disabled agents get NO tool, are absent from `list_agents`, and are NOT fanned out by `run_all`.
4. G4 — An unknown name in `MCP_AGENTS` throws at wiring time with an actionable message listing valid names (fail fast; stdio entry exits 1 via existing fatal handler; HTTP entry fails at startup, not per-request).
5. G5 — `list_agents` availability probe for claude uses `claude --version`.
6. G6 — Docker image installs the claude CLI; compose passes `MCP_AGENTS` and `ANTHROPIC_API_KEY` through.
7. G7 — README documents the new tool, the toggle, and claude auth in Docker.

## Constraints (must NOT)
- H1 — All v0.1 constraints hold (C1–C5: adapter purity, argv/stdin no-shell, no network in server, no new runtime deps, no stdout writes).
- H2 — No second toggle mechanism (no deny-list, no config file) in this iteration.
- H3 — `buildServer` signature/behavior unchanged — filtering happens in the registry layer before `buildServer(adapters, …)` is called.
- H4 — Default behavior with no env set is identical to today plus the added `claude` tool (additive only).

## Out of scope
Per-agent default models/timeouts, runtime toggling, config files, session resume, npm publish.

## Acceptance criteria
- B1 — `tests/adapters/claude.test.ts`: invocation without model, with model, flag-like-prompt safety (stdin), identity — mirroring the other adapters.
- B2 — Registry: `allAdapters()` order `codex,cursor,opencode,claude`; `enabledAdapters` returns all when `MCP_AGENTS` is unset, empty, or parses to no names (explicit `","` test); returns exactly the named subset (order preserved, whitespace trimmed, duplicates deduped); throws naming the invalid entry and listing valid names (generated from the registry) for unknown agents — validation happens before filtering so typos are never silently dropped.
- B3 — Server: tool list becomes the seven sorted names incl. `claude` and `run_all`; a server built from a filtered registry exposes only the enabled agent tools and `list_agents`/`run_all` reflect the same subset (test with `MCP_AGENTS`-style filtered list).
- B4 — `run_all` forwarding test extended to assert claude's exec call (binary `claude`, stdin prompt, options forwarded).
- B5 — Full suite + typecheck + build green locally AND in CI (self-hosted runner) after push.
- B6 — Docker: `docker compose config -q` clean; Dockerfile installs the claude CLI (verified in CI docker job build).
- B7 — README shows the `claude` tool row, `MCP_AGENTS` usage (stdio env + compose), and `ANTHROPIC_API_KEY` note.

## Edge cases
- `MCP_AGENTS="codex, claude"` (spaces) → works; `MCP_AGENTS=""` → all; `MCP_AGENTS=","` → treated as empty → all; duplicate names → deduped (or harmless duplicates prevented — spec: dedupe).
- `MCP_AGENTS=clade` (typo, from the user's own message!) → fail-fast error listing `codex, cursor, opencode, claude` — this is the motivating case for G4.
- Recursive use (hub called from Claude Code invoking `claude`) → allowed; `MCP_AGENTS` lets operators disable claude to prevent it.
- Claude CLI unauthenticated in container → tool returns the CLI's stderr via existing exit-code path; `list_agents` still reports installed.

## Open questions
None — pending only research confirmation of exact claude argv/package (gate blocks on it).
