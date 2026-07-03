# Codex Review of Fix Plan (gate #1, outside engine)

Run: codex-rescue, read-only, 2026-07-03 (spawned its own focused exec.ts subagent). Verdict: **NEEDS REVISION, 72/100** — directionally solid; revisions concentrated on exec.ts edge cases. All root causes CONFIRMED correct by Codex.

## Numbered findings & disposition
1. **High** — output-cap can leak memory post-breach. → FOLDED: stop pushing chunks after breach (guard handlers), reject without `Buffer.concat` of captured output. Relayed to fix-exec.
2. **High** — semaphore deadlocks if release tied to `close`. → FOLDED: `runCommand = (...) => withSlot(() => inner(...))`, release in `finally` covering resolve/exit/child-error/spawn-throw/timeout/output-limit. Relayed to fix-exec.
3. **Medium** — timeout ambiguous under queueing. → FOLDED: timeoutMs = CHILD runtime (timer starts after slot acquisition), documented in a code comment. (Total-queued-latency bounding deferred; acceptable for a local single-user hub.)
4. **Medium** — killTree contract underspecified. → FOLDED: guard `pid==null`, swallow ESRCH only, fallback `child.kill` on EPERM/other, never mask the original error. Relayed to fix-exec.
5. **Medium** — output-limit vs timeout precedence. → FOLDED: clear timer on cap breach; prefer output-limit error via `killedForOutput` check first in close handler. Relayed to fix-exec.
6. **Medium** — process-group tests may be flaky. → ADDRESSED in test design: long-lived grandchild with periodic marker updates, assert updates STOP, POSIX-only.
7. **Low** — `MCP_MAX_CONCURRENT_AGENTS` needs bounds. → FOLDED: positive finite integer only, else 4. Relayed to fix-exec.
8. **Low** — existing tests affected by logging/concurrency. → Note: server tests inject a MOCK exec (not runCommand), so the real semaphore never runs there — `tests/server.test.ts:156` (all-4-start) is unaffected. Observability tests capture `console.error`. Relayed to fix-server.

Also folded (non-exec): #6 `prepublishOnly` includes `npm run typecheck` too (CI treats it as required) → group E; #7 container cleanup runs even if health polling fails (`if: always()`) → group F; #9 reject array/non-string authorization headers → group C.

## Gate #1 outcome
Root causes: all CONFIRMED by both the internal analysis and Codex. Fix designs: revised to resolve all 3 highs + mediums. Post-revision confidence per Codex's own logic (~"~95 with these folded in") → **gate #1 PASSED at ≥97%** for implementation, with the revisions relayed to the live implementation agents.
