# Root-Cause Analysis — re-review fixes (round 2)

(Round-1 analysis preserved in git history at this path.) Sources: re-review (all 7 CONFIRMED with file:line) + direct code reading of the post-hardening HEAD `924174f`. INVERT reasoning per item.

## P1.1 — Fail-open auth on the RCE endpoint — `src/httpServer.ts:74-80`, `Dockerfile:40`
- Symptom: `docker run -p 3919:3919 agent-mcp-hub` (no token) → anyone on the network can POST /mcp and spawn agent CLIs (arbitrary code execution) using the container's API keys.
- Backward trace: per-request auth is `const token = process.env.MCP_TOKEN; if (token && !isTokenValid(...)) 401` → **token unset ⇒ the `if` is skipped ⇒ every POST accepted**. The image ships `ENV HOST=0.0.0.0` (Dockerfile:40) so it binds all interfaces, and nothing at startup ties a non-loopback bind to a required token. `isOriginAllowed(undefined)===true` so a non-browser `curl` (no Origin) sails past the Origin gate too — the token is the only real barrier and it is off by default.
- Wrong assumption: "operators will set MCP_TOKEN before exposing the port." Secure-by-default must not depend on that for a code-execution service.
- Fix invariant: the process must REFUSE to bind a non-loopback host without `MCP_TOKEN` (fail closed). The image must not default to a non-loopback bind.
- Confidence: 99%.

## P2.1 — Semaphore has no fast-fail / bounded queue — `src/exec.ts` (Semaphore)
- Symptom: a burst of POSTs against a saturated pool (default 4) blocks indefinitely — `acquire()` only ever resolves, `waiters[]` is unbounded, and child `timeoutMs` starts only after acquisition — so queued requests wait behind up-to-5-min children with no 503 backpressure.
- Wrong assumption: "a queue alone is sufficient backpressure." An unbounded queue converts overload into unbounded latency, not shed load. The round-1 ask was "queue OR fast-fail"; only the queue shipped.
- Fix invariant: bound the wait queue; reject excess acquirers with a typed busy error that surfaces as an `isError` tool result.
- Confidence: 98%.

## P3.1 — engines node>=20 vs Node 22 requirement — `package.json:9`
- `@anthropic-ai/claude-code` needs Node 22+; CI + both Docker stages use 22; but `engines:>=20` lets a Node 20 install pass the advisory check, then the claude adapter's spawned CLI fails at runtime. Fix invariant: declared floor = real floor (>=22). Confidence: 99%.

## P3.2 — Node PID 1 with no init (zombie reaping) — `docker-compose.yml`, `Dockerfile:44`
- `CMD ["node","dist/http.js"]` makes Node PID 1; Node does not reap reparented orphans. Detached agent grandchildren that outlive their parent become zombies; with `restart: unless-stopped` they accumulate. The round-1 process-group kill fixed the LEAK but not the reaping of any strays. Fix invariant: a real init (tini) reaps zombies + forwards signals. Confidence: 98%.

## P3.3 — No lint/format gate — `.github/workflows/ci.yml`
- CI runs test/typecheck/build, no lint; strict tsc misses floating promises, unused code, import hygiene. Fix invariant: a lint gate in CI. Confidence: 99% (test-debt/quality-gate, not a runtime bug).

## P3.4 — compose image tag hardcodes version — `docker-compose.yml:4`
- `image: agent-mcp-hub:0.1.0` duplicates the now-single-sourced version → silent drift on next release (cosmetic; local build only). Fix invariant: single-source the version. Confidence: 98%.

Gate #1: all ≥97%; Codex plan review in 03b before implementation.
