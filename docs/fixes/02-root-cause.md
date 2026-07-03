# Root-Cause Analysis — pre-release fixes

Root causes are grounded in the pre-release review (per-finding 70–92%) plus direct code reading. INVERT reasoning per item: symptom → what must be true → wrong assumption.

## P1

### #1 Orphaned subprocess trees on timeout — `src/exec.ts:29-32`
- Symptom: after a timeout, `codex`/`claude`/etc. keep running (CPU/API spend continues) in the long-lived container.
- Backward trace: timeout fires → `child.kill("SIGKILL")` → signals ONLY the direct child PID. The wrapped CLIs are launchers that fork their own workers; those workers are in the child's process group but are NOT the direct child, so they survive. `spawn` without `detached` puts the child in the PARENT's process group, so we cannot group-signal without killing ourselves.
- Wrong assumption: "killing the child kills its descendants." False for process trees.
- Fix invariant: the child must be its own process-group leader (`detached: true`) so `process.kill(-pid, SIGKILL)` reaps the whole tree.
- Confidence: 98%.

## P2

### #2 Unbounded output buffering — `src/exec.ts:24-25,41-42`
- Symptom: a verbose/looping agent (×4 via run_all) grows `stdoutChunks` without limit → Node heap OOM → whole hub dies.
- Wrong assumption: "agent output is bounded." A wrapped LLM CLI can stream indefinitely.
- Fix invariant: enforce a byte ceiling during accumulation; on breach, kill the group and fail with a truncation marker.
- Confidence: 97%.

### #3 No spawn concurrency cap — `src/httpServer.ts` (stateless per-request) + `src/exec.ts`
- Symptom: each POST /mcp can spawn 4 CLIs; N concurrent requests → 4N heavyweight processes → PID/memory exhaustion (no auth if MCP_TOKEN unset).
- Wrong assumption: "request volume is low." Unbounded for a network service.
- Fix invariant: a global semaphore in the single spawn chokepoint (`exec.ts`) bounds concurrent children; excess queues.
- Confidence: 97%.

### #4 startHttpServer never rejects on listen failure — `src/httpServer.ts` (listen promise)
- Symptom: EADDRINUSE/EACCES emits an unhandled `'error'` → raw crash, bypassing `http.ts`'s fatal handler.
- Backward trace: `new Promise(resolve => httpServer.listen(...))` has no `'error'` handler; `listen` errors are emitted, not thrown.
- Wrong assumption: "listen always succeeds."
- Fix invariant: attach `once("error", reject)` before `listen`, remove on success.
- Confidence: 98%.

### #5 Unpinned agent CLIs — `Dockerfile:18`
- `npm install -g @openai/codex opencode-ai @anthropic-ai/claude-code` floats to latest each build → non-reproducible, silent supply-chain drift.
- Fix invariant: pin exact versions; Dependabot/manual bumps become visible. Confidence: 99%.

### #6 publish ships stale/missing dist — `package.json`
- `files:["dist"]`, `dist/` gitignored, no prepublish build → `npm publish` from a clean clone ships nothing/stale.
- Fix invariant: `prepublishOnly` builds+tests before pack. Confidence: 97% (latent; publish not yet done).

### #7 CI never runs the image — `.github/workflows/ci.yml` docker job
- Build-only; a broken CMD/missing dep ships green.
- Fix invariant: boot the container in CI, poll `/healthz`. Confidence: 97%.

### #8 run_all duplicates exec logic — `src/server.ts:86-91` vs `46-53`
- Two copies of buildInvocation→exec→format; already diverged (run_all lacks `model`). Every exec-path fix (incl. #1/#2) must land twice or run_all silently misses it.
- Fix invariant: single `runAdapter()` shared by both. Confidence: 98%.

## P3
- #9 Non-constant-time token compare — `src/httpServer.ts:59`: `!==` on secret is variable-time (CWE-208). Fix: sha256 + `timingSafeEqual`. Confidence: 97% (low exploitability, real defect).
- #10 HEALTHCHECK hardcodes 3919 — `Dockerfile`: ignores PORT env. Fix: shell-form with `${PORT:-3919}`. Confidence: 98%.
- #11 No origin-allowlist / malformed-Origin tests — `tests/http.test.ts`: uncovered branches (`httpServer.ts:15-24`). Fix: add tests (pure test-debt). Confidence: 99%.
- #12 No per-run observability — `src/server.ts:46-73`: no agent/cwd/duration/exit log. Fix: one structured stderr line per invocation (stdio-safe). Confidence: 97%.
- #13 Version hardcoded — `src/server.ts:20`: "0.1.0" duplicated. Fix: read from package.json via `createRequire`. Confidence: 98%.
- #14 Description omits claude — `package.json:4`. Fix: text. Confidence: 100%.

## Gate #1: root cause ≥97% on every item (Codex review in 03b before implementation).
