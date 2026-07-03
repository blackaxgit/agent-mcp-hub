# VERIFICATION — re-review round 2 fixes (2026-07-03)

(Round-1 VERIFICATION preserved in git history at this path.)

Gates: **format:check PASS · lint PASS · 66/66 tests · typecheck clean · build clean.** Compose fail-closed confirmed (`docker compose config` errors without MCP_TOKEN, valid with it).
Gate #2: four-eyes double-check **PASS (97)** · Codex fix-verify (6/7 FIXED + one fair "format" scope catch, now closed → all 7) · orchestrator integrated run green.

| # | Issue | Status | Root cause | Fix (where) | Regression test | Confidence |
|---|---|---|---|---|---|---|
| P1.1 | Fail-open auth on RCE endpoint | FIXED | unset MCP_TOKEN ⇒ every POST accepted; image bound 0.0.0.0 | fail-closed startup guard: refuse non-loopback bind without MCP_TOKEN (`src/httpServer.ts`); drop `ENV HOST=0.0.0.0` (`Dockerfile`); require token in compose (`${MCP_TOKEN:?}`) | "refuses to bind a non-loopback host without MCP_TOKEN" (differentiating) | 99% |
| P2.1 | Semaphore no fast-fail / unbounded queue | FIXED | `acquire()` only resolved, `waiters[]` unbounded | bounded queue → `ServerBusyError` before enqueue (`MCP_MAX_QUEUE`, `src/exec.ts`) → isError | "rejects with ServerBusyError when the queue is full" (differentiating) | 98% |
| P3.1 | engines node>=20 vs Node 22 | FIXED | advisory floor below real floor | `"engines": {"node": ">=22"}` (`package.json`) | inspection | 99% |
| P3.2 | Node PID 1, no init (zombie reaping) | FIXED | no init to reap re-parented orphans | bake `tini` as `ENTRYPOINT` (`Dockerfile`) | inspection + CI image smoke | 98% |
| P3.3 | No lint/format gate | FIXED | no ESLint, no formatter | ESLint 9 flat config w/ `no-floating-promises` (src) + Prettier `format:check`; both wired into CI | `npm run lint` + `npm run format:check` exit 0 + CI steps | 98% |
| P3.4 | compose image tag hardcodes version | FIXED | duplicated version literal | `image: agent-mcp-hub:${APP_VERSION:-latest}` (`docker-compose.yml`) | inspection | 98% |

## Notes / honest caveats
- **P3.3 "format" half:** Codex's fix-verification (04b) correctly flagged that the finding title said "lint/**format**" and only lint had shipped. Closed by adding Prettier (`.prettierrc.json`, `format`/`format:check` scripts, `eslint-config-prettier`, CI `format:check` step). Markdown is excluded from the formatter (prose, not code) — the gate governs code files. ESLint `no-floating-promises` found ZERO floating promises in src, confirming the round-1/round-2 `void`-discard patterns are correct.
- **P3.3 test-scope:** `no-floating-promises` is scoped to `src/**` only (tsconfig `include` is `src`, so tests aren't in the type-checked project). Accepted, documented — tests aren't the code-execution surface; `no-unused-vars` still lints tests. (four-eyes DOWNGRADE reason; not an open defect.)
- **Codex PLAN review (gate #1) was inconclusive** this round (forwarder issue, 03b) — compensated by 4-team re-review CONFIRMED findings + independent research + the Codex/four-eyes VERIFICATION at gate #2. The plan gate leaned on research rather than an independent engine; the fix gate had both.

## Codex: agrees (after format closed). Four-eyes double-check: **PASSED (97)**.
All 7 findings resolved at root cause, not masked or moved. Per-issue confidence ≥98%.
