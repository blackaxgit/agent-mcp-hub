# 03 — Red Team (adversarial findings)

RE-REVIEW (round-2, post-hardening). 5 findings, raw (pre-filter). Verification outcomes are cross-referenced in `07-filtered.md`.

## R1 — Fail-open auth: default image binds 0.0.0.0 with no token = unauthenticated remote code execution
- **severity:** critical
- **file:** `src/httpServer.ts:74-80` (with `Dockerfile:40` `ENV HOST=0.0.0.0`, `docker-compose.yml:14` `MCP_TOKEN` default empty)
- **problem:** The `/mcp` endpoint spawns arbitrary coding-agent CLIs (claude/codex/cursor/opencode) against a caller-supplied prompt and cwd — i.e. full code execution on the host. Authentication is entirely optional: `const token = process.env.MCP_TOKEN; if (token && !isTokenValid(...))`. When MCP_TOKEN is unset the token branch is skipped and every POST is accepted. The Dockerfile ships `ENV HOST=0.0.0.0` and docker-compose defaults `MCP_TOKEN` to empty, so `docker run -p 3919:3919 agent-mcp-hub` (publishing on all interfaces, the common case) yields an unauthenticated network endpoint that any reachable host can drive to execute code, read/write files, and use the mounted OPENAI/ANTHROPIC/CURSOR API keys. The Origin check is no barrier: non-browser clients (curl) send no Origin, and `isOriginAllowed(undefined)` returns true, so the token is the only real gate — and it is off by default.
- **fix:** Fail closed: refuse to start (or refuse every request) when bound to a non-loopback host without a token. At the top of startHttpServer add: `const token = process.env.MCP_TOKEN; const isLoopback = host === '127.0.0.1' || host === '::1' || host === 'localhost'; if (!isLoopback && !token) throw new Error('MCP_TOKEN is required when HOST is not loopback — refusing to expose an unauthenticated agent-execution endpoint');`. Reuse that resolved `token` in the per-request check. Remove `ENV HOST=0.0.0.0` from the Dockerfile (or pair it with a mandatory MCP_TOKEN and document that publishing beyond loopback requires the token).

## R2 — Origin allowlist is not authentication and is trivially bypassed by non-browser clients
- **severity:** medium
- **file:** `src/httpServer.ts:29-41`
- **problem:** `isOriginAllowed(undefined)` returns true, so any client that simply omits the Origin header (all non-browser HTTP clients, e.g. curl or a compromised LAN host) passes the origin gate. The header-based DNS-rebinding defense only constrains real browsers; it provides zero protection against direct HTTP attackers. Code comments and README present this check as a security boundary for an endpoint that can spawn coding agents, which invites operators to expose the service relying on origin filtering instead of the (optional) token.
- **fix:** Do not treat the Origin check as an access-control boundary. Keep it strictly as an anti-DNS-rebinding measure and make the bearer token the required gate for any non-loopback bind (see R1). Update README/comments to state explicitly that the Origin allowlist is not authentication and that MCP_TOKEN is mandatory whenever the port is reachable beyond loopback.

## R3 — Unbounded semaphore waiter queue enables memory-exhaustion DoS
- **severity:** medium
- **file:** `src/exec.ts:61-84` (queueing at 86-96; fan-out at `src/server.ts:122-125`)
- **problem:** runCommand routes every spawn through a Semaphore whose `waiters` array grows without limit. Each POST /mcp can enqueue up to N agents (run_all fans out to every adapter), and there is no cap on concurrent requests, queued waiters, or in-flight prompt buffers. An attacker who can reach the endpoint (unauthenticated per R1, or any authorized caller) can issue many concurrent run_all calls; excess invocations pile up in `waiters` along with their retained prompt strings and pending promises, exhausting memory while the concurrency cap only throttles actual spawns. There is also no request-body / prompt size limit backing this.
- **fix:** Bound the queue: give Semaphore a max-waiters limit and reject `acquire()` with a 'server busy' error once exceeded, surfacing a 429/`-32000` to the client instead of buffering unboundedly. Additionally cap concurrent in-flight /mcp requests and enforce a maximum request body size in startHttpServer before invoking the transport.

## R4 — Unvalidated cwd lets callers run agents in any directory (arbitrary read/write/exfiltration)
- **severity:** medium
- **file:** `src/server.ts:50` (`cwd: z.string()`), passed to spawn at `src/exec.ts:102-106`
- **problem:** The `cwd` tool parameter is an unconstrained string handed straight to `spawn({ cwd })`. There is no allowlist or containment, so a caller can point an agent at any path the server process can access (e.g. /etc, another repo containing secrets, ~/.ssh) and, because the spawned coding agent can read/write files and call outbound APIs using the container's mounted credentials, exfiltrate or tamper with data far outside the intended /workspace mount. On the default unauthenticated image this is remotely reachable.
- **fix:** Enforce a cwd allowlist rooted at a configured base (e.g. MCP_WORKSPACE_ROOT, defaulting to /workspace): resolve the requested path with path.resolve and reject anything that does not stay within the root (`resolved === root || resolved.startsWith(root + path.sep)`), returning an actionable error before spawning. Document that cwd must live under the workspace root.

## R5 — Unbounded caller-supplied timeoutMs allows indefinite slot/resource holding
- **severity:** low
- **file:** `src/server.ts:51-56` and `119`
- **problem:** timeoutMs is validated only as a positive integer with no upper bound. A caller can pass a huge value (e.g. Number.MAX_SAFE_INTEGER) so a spawned agent holds one of the limited concurrency slots effectively forever, and repeating this across the slot count wedges the server for all users. Combined with the unauthenticated default, an outsider can pin all slots. (Verification caveat: Node clamps setTimeout delays > 2^31-1 ms to ~1 ms, so MAX_SAFE_INTEGER does not hold forever — the realistic worst case is ~24.8 days.)
- **fix:** Clamp the timeout to a sane maximum (e.g. cap at the intended 300000 ms ceiling, `Math.min(requested, MAX_TIMEOUT_MS)`), so no single invocation can hold a slot beyond an operationally reasonable bound.
