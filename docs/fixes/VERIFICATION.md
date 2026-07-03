# VERIFICATION — pre-release bug fixes (2026-07-03)

Suite: **62/62 tests pass (11 files, +9 regression tests over the 53 baseline)**, typecheck clean, build clean, stdio smoke OK.
Gate #2: Codex AGREES (94) · four-eyes double-check PASS (92) · orchestrator integrated run green.

| # | Issue | Status | Root cause | Fix (where) | Regression test | Confidence |
|---|---|---|---|---|---|---|
| 1 | Orphaned subprocess trees on timeout | FIXED | direct-child SIGKILL leaves group members | detached spawn + `process.kill(-pid)` group kill w/ ESRCH-swallow + EPERM fallback (`src/exec.ts`) | "group-kills a grandchild that outlives the timed-out child" (differentiating) | 98% |
| 2 | Unbounded output buffering | FIXED | no byte ceiling | cap + stop-accumulate + kill group, reject w/o concat (`src/exec.ts`) | output-cap kill + "does not echo captured bytes" (differentiating: hangs pre-fix) | 98% |
| 3 | No spawn concurrency cap | FIXED | unbounded parallel spawns | FIFO semaphore, `MCP_MAX_CONCURRENT_AGENTS` (`src/exec.ts`) | "never runs more than MAX_CONCURRENT_AGENTS" (differentiating) | 97% |
| 4 | startHttpServer never rejects on listen error | FIXED | no `error` handler on listen | `once("error", reject)`/`once("listening", resolve)` (`src/httpServer.ts`) | "rejects a request whose port is already bound" (differentiating) | 98% |
| 5 | Unpinned agent CLIs | FIXED | floating `npm -g` | pinned `@0.142.5/@1.17.13/@2.1.199` (`Dockerfile`) | inspection + CI build | 99% |
| 6 | publish ships stale dist | FIXED | no prepublish build | `prepublishOnly: build && typecheck && test` (`package.json`) | inspection | 98% |
| 7 | CI never runs the image | FIXED | build-only job | boot + poll `/healthz` + teardown (`ci.yml`) | the CI run itself | 97% |
| 8 | run_all duplicates exec logic / no model | FIXED | copy-paste divergence | shared `runAdapter()` both paths (`src/server.ts`) | "forwards model to every adapter invocation" (differentiating) | 98% |
| 9 | Non-constant-time token compare | FIXED | `!==` on secret | `timingSafeEqual(sha256,sha256)` (`src/httpServer.ts`) | 401-parity test (NON-differentiating — timing not unit-testable; verified by inspection + Codex + four-eyes) | 97% |
| 10 | HEALTHCHECK hardcodes port | FIXED | exec-form, no env | shell-form `${PORT:-3919}` (`Dockerfile`) | inspection | 98% |
| 11 | No origin/malformed-Origin tests | FIXED | test debt | allow/block/malformed tests (`tests/http.test.ts`) | 3 new origin tests (differentiating for the branches) | 99% |
| 12 | No per-run observability | FIXED | no logging | one stderr `agent_run` line, no prompt/output (`src/server.ts`) | "emits exactly one structured agent_run line…no prompt" (differentiating) | 97% |
| 13 | Server version hardcoded | FIXED | duplicated literal | `createRequire(...package.json).version` (`src/server.ts`) | version-parity test (NON-differentiating at current 0.1.0 parity; verified by inspection) | 97% |
| 14 | Description omits claude | FIXED | stale text | updated (`package.json`) | inspection | 100% |

## Honest caveats (transparent, non-blocking)
- **#9 and #13 regression tests are non-differentiating** (pass on pre-fix code too): timing-safety is not unit-observable and version parity is currently 0.1.0=0.1.0. Both fixes are correct in code — confirmed by inspection AND both independent reviewers. #13 will catch future drift.
- **Observability gap (minor, non-regressive):** `runAdapter` builds the invocation before its timed try, so an opencode dash-guard rejection emits no `agent_run` line. Arguably correct (no process ran); observability is new so nothing regressed. Logged for a future pass.
- **cursor-agent stays installer-based/unpinned** (vendor publishes no checksum) — intentional, commented in the Dockerfile.
- **Docker smoke runs on main-push only** (disk-constrained self-hosted runner) — documented CI decision.

## Codex: agrees (94). Four-eyes double-check: **PASSED** (92), recommends SHIP.

All 14 root causes resolved in code, not masked or moved. Per-issue confidence ≥97%.
