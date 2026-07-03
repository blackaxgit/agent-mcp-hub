# Codebase Analysis — Feature 2: Claude adapter + agent toggles

(v0.1 greenfield analysis preserved in git history at this path.)

## Current state (post-v0.1 + Docker/HTTP + CI)
TypeScript strict ESM (NodeNext), Node ≥20. 43 tests green, CI on self-hosted runner (secrets → test → docker jobs). Layering: pure adapters → `src/exec.ts` subprocess boundary → `src/server.ts` MCP wiring → entries (`src/index.ts` stdio, `src/http.ts`/`src/httpServer.ts` streamable HTTP, stateless per-request `buildServer`).

## Feature touchpoints
| File | Change |
|---|---|
| `src/adapters/claude.ts` (new) | `claudeAdapter` — `buildInvocation → {args, stdin}` like codex/cursor |
| `tests/adapters/claude.test.ts` (new) | same 4-test pattern as other adapters |
| `src/registry.ts` | register claudeAdapter; add `enabledAdapters(env)` filtering by `MCP_AGENTS` (allowlist, unset → all, unknown name → throw actionable error) |
| `tests/registry.test.ts` | order/filter/fail-fast tests |
| `src/index.ts`, `src/httpServer.ts` | use `enabledAdapters()` instead of `allAdapters()` |
| `tests/server.test.ts` | tool-list assertion gains `claude` (6→7 tools); add filtered-adapters test |
| `tests/http.test.ts` | unaffected (ping only) — verify |
| `Dockerfile` | install claude CLI in runtime stage |
| `docker-compose.yml` | pass `MCP_AGENTS`, `ANTHROPIC_API_KEY` through |
| `README.md` | tools table + config section |

## Constraints to preserve
- C1/C5 guard tests (adapters stay pure; no stdout writes).
- `run_all` and `list_agents` operate on the SAME filtered adapter list the tools are built from (single source: adapters array passed to `buildServer` — filtering happens before `buildServer`, so no changes inside server.ts itself).
- exec/timeout/error contracts unchanged.

## Breakage risk
The server tool-list test (`exactly six tools`) and spec F2 need updating to seven; `run_all` forwarding test asserts per-adapter argv — claude addition extends it. No migrations; no external breakage (new tool is additive; toggles default to all-on).

## Interleaving hazard
Dependabot PR triage is running concurrently on `main` (merges will move origin/main; `git pull --rebase` before each push of this feature).
