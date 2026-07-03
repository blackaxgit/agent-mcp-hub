# Pre-Release Review — agent-mcp-hub (RE-REVIEW, post-hardening)

## Verdict: DO NOT SHIP (confidence 80%)

This is a **re-review after the round-1 hardening pass**. The 14 prior confirmed findings (process-tree leaks, unbounded buffering, fork-bomb/concurrency cap, listen-failure handling, unpinned CLIs, publish/dist safety, Docker smoke test, timing-safe token, healthcheck port, version single-source, package metadata, etc.) were re-checked against the current code and **verified fixed — they are not re-reported here.** What follows is the residual set found on the hardened tree.

One P1 defense-in-depth blocker must land first: the RCE-capable `/mcp` endpoint fails **open** (auth skipped entirely when `MCP_TOKEN` is unset) and the runtime image ships `ENV HOST=0.0.0.0`. The shipped `docker-compose.yml` mitigates this (loopback-only bind + documented token/TLS), so it is not exploitable in the intended config — but "safe only if the operator doesn't type the obvious `docker run -p 3919:3919`" is not an acceptable secure-by-default posture for a code-execution service at release. The fix is a ~3-line fail-closed startup guard plus dropping the Dockerfile `HOST` default: small, well-understood, high-value. Ship-blocking until merged. Everything else is P2/P3 (non-blocking). Secret scan: **clean** (gitleaks git + filesystem, exit 0; no credential values).

## Top 3 Blockers
1. **Fail-open auth on an RCE endpoint shipped with `HOST=0.0.0.0` and no fail-closed guard** — `src/httpServer.ts:74-80` + `Dockerfile:40`. (P1)
2. **Concurrency semaphore has no acquire timeout / queue bound / fast-fail** — unbounded stalls under load, no 503 backpressure — `src/exec.ts:69`. (P2)
3. **`engines: node>=20` contradicts the Node 22 runtime requirement** — silent partial breakage of the claude adapter on Node 20 — `package.json:9`. (P3, highest-value of the lows: install-time correctness)

---

## P1 — Must Fix Before Release

### P1.1 Fail-open authentication on RCE endpoint (secure-by-default gap)
- **file:line:** `src/httpServer.ts:74-80` (with `Dockerfile:40` `ENV HOST=0.0.0.0`, `docker-compose.yml:14` default empty `MCP_TOKEN`)
- **problem:** POST `/mcp` registers tools (`codex`/`cursor`/`claude`/`opencode`/`run_all`) that spawn autonomous agent CLIs = arbitrary code execution at a caller-controlled `cwd`, holding the container's `OPENAI_API_KEY`/`CURSOR_API_KEY`/`ANTHROPIC_API_KEY`. Auth is optional: `const token = process.env.MCP_TOKEN; if (token && !isTokenValid(...))` — unset token ⇒ every POST accepted. The image ships `HOST=0.0.0.0` with no startup guard tying non-loopback binds to a required token; `isOriginAllowed(undefined)` returns true (line 30), so curl bypasses the Origin gate and the token is the only real barrier — off by default. The natural `docker run -p 3919:3919 agent-mcp-hub` publishes unauthenticated RCE on all interfaces. Secondary facets: on shared loopback hosts any local process can drive the credential-holding endpoint (confused deputy); `cwd` is unrestricted to the filesystem.
- **fix:** Fail closed at startup. Before `httpServer.listen(port, host)` in `startHttpServer`: `if (!LOOPBACK_HOSTNAMES.has(host) && !process.env.MCP_TOKEN) throw new Error('Refusing to bind non-loopback host without MCP_TOKEN')`. Reuse that resolved token in the per-request check. Remove `ENV HOST=0.0.0.0` from the Dockerfile (keep http.ts default 127.0.0.1); document that exposing the port requires BOTH `MCP_TOKEN` and a TLS reverse proxy. Optionally: always require a token, and constrain agent `cwd` to an allowlisted root (default mounted `/workspace`).
- **severity:** high (rated critical by Red, high by Security; merged — same weakness)
- **effort:** ~3 lines (startup guard) + 1 Dockerfile line removed + doc note
- **source:** red + security (corroborated)
- **status:** CONFIRMED (verifier real=true, confidence 72–78)

---

## P2 — Should Fix

### P2.1 Concurrency semaphore: no acquisition timeout, queue bound, or fast-fail backpressure
- **file:line:** `src/exec.ts:69` (waiter queue; child timeout starts post-acquire at line 118)
- **problem:** `MAX_CONCURRENT_AGENTS` caps spawns but `Semaphore.acquire()` only ever resolves — never rejects/times out — and `waiters[]` is unbounded. Child `timeoutMs` starts only after the slot is acquired, so a burst of POSTs against a saturated pool (default 4) blocks indefinitely behind up to 5-min children; latency grows unbounded, clients time out holding sockets/promises. Prior remediation A2 asked for "queue OR fast-fail"; only the queue shipped — no load-shedding path.
- **fix:** Add a bounded-wait option: accept `maxQueue`/`acquireTimeoutMs`, reject with a typed "server busy, retry" error when exceeded, surface it in `server.ts` as an `isError` result (HTTP 503-equivalent). Env-gate via `MCP_MAX_QUEUE`. Minimum viable: cap `waiters.length` and reject `acquire()` when full so callers get an actionable busy error instead of an unbounded stall.
- **severity:** medium
- **effort:** small (bounded-wait option on the existing Semaphore + one call-site branch)
- **source:** architecture
- **status:** CONFIRMED (verifier real=true, confidence 70)

---

## P3 — Nice to Have / Post-Release

### P3.1 `engines: node>=20` conflicts with the Node 22 runtime requirement
- **file:line:** `package.json:9`
- **problem:** Declares `"engines": { "node": ">=20" }`, but `@anthropic-ai/claude-code` needs Node 22+ (Dockerfile:17), and CI (ci.yml:34) + both Docker stages use Node 22. A Node 20 global install passes the (advisory) engines check; the claude adapter's spawned CLI then fails at runtime — silent partial breakage.
- **fix:** Set `"engines": { "node": ">=22" }` to match the CI/Docker baseline and the wrapped-CLI requirement.
- **severity:** low — **effort:** one line — **source:** green — **status:** CONFIRMED (real=true, confidence 80)

### P3.2 Container runs Node as PID 1 with no init (zombie reaping / signal forwarding)
- **file:line:** `docker-compose.yml:29` (with `Dockerfile:44` `CMD ["node","dist/http.js"]`)
- **problem:** No `init: true` and no tini/dumb-init, so Node is PID 1 and does not reap reparented orphans. Detached agent grandchildren that outlive their parent become zombies; with `restart: unless-stopped` and long-lived operation they can accumulate. Architecture finding A1 was only half-fixed (process-group kill, not an init).
- **fix:** Add `init: true` under the service in docker-compose.yml. For non-compose runners, add `ENTRYPOINT ["/usr/bin/tini", "--"]` (after installing tini) in the Dockerfile runtime stage.
- **severity:** low — **effort:** one compose line (plus optional Dockerfile ENTRYPOINT) — **source:** green — **status:** CONFIRMED (real=true, confidence 76)

### P3.3 No lint/format gate in CI or repo
- **file:line:** `.github/workflows/ci.yml:36-39`
- **problem:** Test job runs `npm test`, `typecheck`, `build` — no lint step, no ESLint/Prettier config. Strict `tsc` misses unused code, import hygiene, floating promises, style drift; quality regressions ship green.
- **fix:** Add ESLint + `@typescript-eslint` (flat `eslint.config.js`) with `no-floating-promises` and `no-unused-vars`, a `"lint": "eslint ."` script, and `- run: npm run lint` before `npm run build` in the test job.
- **severity:** low — **effort:** small (config + script + one CI line) — **source:** green — **status:** CONFIRMED (real=true, confidence 80)

### P3.4 docker-compose image tag hardcodes the version (single-source drift)
- **file:line:** `docker-compose.yml:4`
- **problem:** `image: agent-mcp-hub:0.1.0` duplicates package.json version (now single-sourced in server.ts after A5). Next release requires a manual lockstep bump; if missed, the local image tag silently disagrees with the advertised server version. (Cosmetic — local `build: .`, no registry push.)
- **fix:** Use `image: agent-mcp-hub:${APP_VERSION:-latest}` (or omit `image:`), derive `APP_VERSION` from package.json in the release script, and add a CI check asserting the compose tag matches package.json.
- **severity:** low — **effort:** one compose line (plus optional CI assert) — **source:** architecture — **status:** CONFIRMED (real=true, confidence 80)

---

## Also surfaced (verified real, held below the reconciled P1/P2/P3 set)

These were confirmed reachable this round but kept off the priority list on lower confidence/severity (details in `07-filtered.md`):

- `run_all` never sets `isError` on total failure — API-contract asymmetry vs the per-agent tool — `src/server.ts:141` (arch, real=true, conf 68).
- No SIGTERM/graceful-drain handler — in-flight `/mcp` requests and agent children dropped abruptly on deploy — `src/httpServer.ts:43` (green, real=true, conf 65).
- Unbounded caller-supplied `timeoutMs` — one call can hold a slot up to ~24.8 days (Node clamps beyond ~2^31-1 ms) — `src/server.ts:51-56` (red, real=true, conf 60).
- Unbounded semaphore waiter memory under load — retained request/prompt buffers, reachable only off the loopback default — `src/exec.ts:61-84` (red, real=true, conf 58).
- `list_agents` liveness probe competes for the heavyweight execution semaphore — monitoring latency coupled to execution load — `src/server.ts:73` (arch, real=true, conf 58).
- Unvalidated `cwd` containment — weak defense-in-depth; the prompt already reaches any path the process can — `src/server.ts:50` (red, real=true, conf 50).

Dropped as false positives by the filter: Origin-allowlist-is-not-auth (intentional + documented DNS-rebinding guard), host-wide `docker system prune` (intentional disk-headroom tradeoff on a repo-dedicated runner), CI-produces-no-GHCR-artifact (source/compose deploy model, no CD pull), and `checkAvailability` cohesion nit (type-only import, no runtime coupling).

---

**Release gate:** merge P1.1 (fail-closed startup guard + drop `ENV HOST=0.0.0.0`) → re-verify → SHIP. P2.1 strongly recommended in the same cycle if a network-exposed deployment is intended. P3 items non-blocking. Secret scan gate: ran, **clean**.

_Superseded: the 7 findings here were fixed in the round-2 /my-fix-bugs pass (docs/fixes/ round 2)._
