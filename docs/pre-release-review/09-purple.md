# 09 — Purple Team (reconciled verdict)

RE-REVIEW (round-2, post-hardening). Raw reconciliation output from the Purple stage.

# PRE-RELEASE REVIEW — agent-mcp-hub

## VERDICT: DO-NOT-SHIP (confidence 80%)

One P1 defense-in-depth blocker must land first: the RCE-capable `/mcp` endpoint fails **open** (auth skipped entirely when `MCP_TOKEN` is unset) and the runtime image ships `ENV HOST=0.0.0.0`. The shipped `docker-compose.yml` mitigates this (loopback-only bind + documented token/TLS), so it is not exploitable in the intended config — but "safe only if the operator doesn't type the obvious `docker run -p 3919:3919`" is not an acceptable secure-by-default posture for a code-execution service at release. The fix is a ~3-line fail-closed startup guard plus dropping the Dockerfile HOST default: small, well-understood, high-value. Ship-blocking until merged. Everything else is P2/P3 (non-blocking). Secret scan: **clean** (gitleaks git + filesystem, exit 0; no credential values).

## TOP 3 BLOCKERS
1. **Fail-open auth on an RCE endpoint shipped with `HOST=0.0.0.0` and no fail-closed guard** — `src/httpServer.ts:74-80` + `Dockerfile:40`. (P1)
2. **Concurrency semaphore has no acquire timeout / queue bound / fast-fail** — unbounded stalls under load, no 503 backpressure — `src/exec.ts:69`. (P2)
3. **`engines: node>=20` contradicts the Node 22 runtime requirement** — silent partial breakage of the claude adapter on Node 20 — `package.json:9`. (P3, highest-value of the lows: install-time correctness)

---

## P1 — MUST FIX BEFORE RELEASE

### P1.1 Fail-open authentication on RCE endpoint (secure-by-default gap)
- **file:line:** `src/httpServer.ts:74-80` (with `Dockerfile:40` `ENV HOST=0.0.0.0`, `docker-compose.yml:14` default empty `MCP_TOKEN`)
- **severity:** high (rated critical by Red, high by Security; merged — same weakness)
- **source:** red + security (corroborated)
- **problem:** POST `/mcp` registers tools (`codex`/`cursor`/`claude`/`opencode`/`run_all`) that spawn autonomous agent CLIs = arbitrary code execution at a caller-controlled `cwd`, holding the container's `OPENAI_API_KEY`/`CURSOR_API_KEY`/`ANTHROPIC_API_KEY`. Auth is optional: `const token = process.env.MCP_TOKEN; if (token && !isTokenValid(...))` — unset token ⇒ every POST accepted. Image ships `HOST=0.0.0.0` with no startup guard tying non-loopback binds to a required token; `isOriginAllowed(undefined)` returns true (line 30), so curl bypasses the Origin gate and the token is the only real barrier — off by default. Natural `docker run -p 3919:3919 agent-mcp-hub` publishes unauthenticated RCE on all interfaces. Secondary facets: on shared loopback hosts any local process can drive the credential-holding endpoint (confused deputy); `cwd` is unrestricted to the filesystem.
- **fix:** Fail closed at startup. Before `httpServer.listen(port, host)` in `startHttpServer`: `if (!LOOPBACK_HOSTNAMES.has(host) && !process.env.MCP_TOKEN) throw new Error('Refusing to bind non-loopback host without MCP_TOKEN')`. Reuse that resolved token in the per-request check. Remove `ENV HOST=0.0.0.0` from the Dockerfile (keep http.ts default 127.0.0.1); document that exposing the port requires BOTH `MCP_TOKEN` and a TLS reverse proxy. Optionally: always require a token, and constrain agent `cwd` to an allowlisted root (default mounted `/workspace`).

---

## P2 — SHOULD FIX

### P2.1 Concurrency semaphore: no acquisition timeout, queue bound, or fast-fail backpressure
- **file:line:** `src/exec.ts:69` (waiter queue; child timeout starts post-acquire at line 118)
- **severity:** medium
- **source:** architecture
- **problem:** `MAX_CONCURRENT_AGENTS` caps spawns but `Semaphore.acquire()` only ever resolves — never rejects/times out — and `waiters[]` is unbounded. Child `timeoutMs` starts only after the slot is acquired, so a burst of POSTs against a saturated pool (default 4) blocks indefinitely behind up to 5-min children; latency grows unbounded, clients time out holding sockets/promises. Prior remediation A2 asked for "queue OR fast-fail"; only the queue shipped — no load-shedding path.
- **fix:** Add a bounded-wait option: accept `maxQueue`/`acquireTimeoutMs`, reject with a typed "server busy, retry" error when exceeded, surface it in `server.ts` as an `isError` result (HTTP 503-equivalent). Env-gate via `MCP_MAX_QUEUE`. Minimum viable: cap `waiters.length` and reject `acquire()` when full so callers get an actionable busy error instead of an unbounded stall.

---

## P3 — NICE TO HAVE / POST-RELEASE

### P3.1 `engines: node>=20` conflicts with the Node 22 runtime requirement
- **file:line:** `package.json:9`
- **severity:** low
- **source:** green
- **problem:** Declares `"engines": { "node": ">=20" }`, but `@anthropic-ai/claude-code` needs Node 22+ (Dockerfile:17), and CI (ci.yml:34) + both Docker stages use Node 22. A Node 20 global install passes the (advisory) engines check; the claude adapter's spawned CLI then fails at runtime — silent partial breakage.
- **fix:** Set `"engines": { "node": ">=22" }` to match the CI/Docker baseline and the wrapped-CLI requirement.

### P3.2 Container runs Node as PID 1 with no init (zombie reaping / signal forwarding)
- **file:line:** `docker-compose.yml:29` (with `Dockerfile:44` `CMD ["node","dist/http.js"]`)
- **severity:** low
- **source:** green
- **problem:** No `init: true` and no tini/dumb-init, so Node is PID 1 and does not reap reparented orphans. Detached agent grandchildren that outlive their parent become zombies; with `restart: unless-stopped` and long-lived operation they can accumulate. Architecture finding A1 was only half-fixed (process-group kill, not an init).
- **fix:** Add `init: true` under the service in docker-compose.yml. For non-compose runners, add `ENTRYPOINT ["/usr/bin/tini", "--"]` (after installing tini) in the Dockerfile runtime stage.

### P3.3 No lint/format gate in CI or repo
- **file:line:** `.github/workflows/ci.yml:36-39`
- **severity:** low
- **source:** green
- **problem:** Test job runs `npm test`, `typecheck`, `build` — no lint step, no ESLint/Prettier config. Strict `tsc` misses unused code, import hygiene, floating promises, style drift; quality regressions ship green.
- **fix:** Add ESLint + `@typescript-eslint` (flat `eslint.config.js`) with `no-floating-promises` and `no-unused-vars`, a `"lint": "eslint ."` script, and `- run: npm run lint` before `npm run build` in the test job.

### P3.4 docker-compose image tag hardcodes the version (single-source drift)
- **file:line:** `docker-compose.yml:4`
- **severity:** low
- **source:** architecture
- **problem:** `image: agent-mcp-hub:0.1.0` duplicates package.json version (now single-sourced in server.ts after A5). Next release requires a manual lockstep bump; if missed, the local image tag silently disagrees with the advertised server version. (Cosmetic — local `build: .`, no registry push.)
- **fix:** Use `image: agent-mcp-hub:${APP_VERSION:-latest}` (or omit `image:`), derive `APP_VERSION` from package.json in the release script, and add a CI check asserting the compose tag matches package.json.

---

**Release gate:** merge P1.1 (fail-closed startup guard + drop `ENV HOST=0.0.0.0`) → re-verify → SHIP. P2.1 strongly recommended in the same cycle if a network-exposed deployment is intended. P3 items non-blocking. Secret scan gate: ran, **clean**.
