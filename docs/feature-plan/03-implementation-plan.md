# Implementation Plan — agent-mcp-hub v0.1

Authoritative task-level plan (complete code, TDD steps, commit points): `docs/superpowers/plans/2026-07-02-agent-mcp-hub.md`. This document maps it onto multi-agent execution via the Workflow tool (user opted into ultracode/workflows) and records dependencies, test strategy, and rollback.

## Task graph

| # | Task (plan §) | Files owned | Depends on |
|---|---|---|---|
| 1 | Scaffold (Task 1) | package.json, tsconfig.json, tsconfig.test.json, .gitignore, src/types.ts (placeholder), tests/smoke.test.ts | — |
| 2 | exec boundary + types (Task 2) | src/types.ts, src/exec.ts, tests/exec.test.ts | 1 |
| 3a | Codex adapter (Task 3) | src/adapters/codex.ts, tests/adapters/codex.test.ts | 2 |
| 3b | Cursor adapter (Task 4) | src/adapters/cursor.ts, tests/adapters/cursor.test.ts | 2 |
| 3c | OpenCode adapter (Task 5) | src/adapters/opencode.ts, tests/adapters/opencode.test.ts | 2 |
| 4 | Registry (Task 6) | src/registry.ts, tests/registry.test.ts | 3a–3c |
| 5 | Server + run_all (Tasks 7–8) | src/server.ts, tests/server.test.ts | 4 |
| 6 | Bin entry + guards + README (Task 9) | src/index.ts, tests/constraints.test.ts, README.md | 5 |

The plan doc (rev 2) already encodes the per-adapter test files with correct `../../src/...` import depth, the `buildInvocation → {args, stdin?}` adapter contract, and the Task 8 tool-list assertion update — workflow agents 3a–3c own disjoint files and run in parallel. Tasks 7 and 8 merge into one agent (same files).

## Execution model
- Orchestrator (main session): git commits after verifying each phase (subagents never commit), phase gating, final verification.
- Workflow phases: `Scaffold` → `Exec` → `Adapters ×3 (parallel)` → `Registry` → `Server` → `Entry/README`, each agent instructed to follow its plan task verbatim (code is already written in the plan) and return the test command output.
- Research corrections from `01-approach.md` are injected into adapter agents' prompts if argv changed.

## Test strategy per layer
- Unit: adapters (pure argv), registry (mock Exec), exec (real `node -e` subprocesses incl. timeout + ENOENT).
- Integration: `buildServer` exercised through a real MCP `Client` over `InMemoryTransport` with a mocked Exec (success, non-zero exit, rejection, fan-out).
- E2E smoke: `initialize` JSON-RPC piped into built `dist/index.js`.

## Rollback
Each phase is one conventional commit on `main`; revert = `git revert <sha>` (or reset before push). Nothing external is mutated until the final gated push; npm publish is out of scope.

## Progress log
- [x] Phase 1 scaffold (commit 0c5f994)
- [x] Phase 2 exec (commit 1d1e118)
- [x] Phase 3 adapters (commits d5c66a1, a979fb9, cc7cd4b)
- [x] Phase 4 registry (commit b81aa0e)
- [x] Phase 5 server (commit deb0320)
- [x] Phase 6 entry/README (commit e290c5b)
- [x] Verification: 35/35 tests, typecheck + build clean, stdio smoke OK; gitleaks gate clean (11 commits) — Codex cross-check + push pending
