# 03 — Red Team (adversarial findings)

5 findings, raw (pre-filter). Verification outcomes are cross-referenced in `07-filtered.md`.

## R1 — RCE-capable endpoint binds public interfaces with no authentication enforced
- **Severity:** High
- **file:line:** `src/httpServer.ts:27-64` (with `Dockerfile:38` `ENV HOST=0.0.0.0`)
- **Problem:** The `/mcp` endpoint spawns autonomous coding agents (`codex exec`, `claude -p`, etc.) that run arbitrary code/file operations as the host user. Authentication is optional: `MCP_TOKEN` is only checked if set (lines 58-59). The Dockerfile hardcodes `HOST=0.0.0.0`, and the server binds any interface without a token. Running `node dist/http.js` with `HOST=0.0.0.0` and no `MCP_TOKEN` exposes an unauthenticated RCE surface to the whole network. The README's "mandatory before exposing the port" guidance is a comment, not a control. The Origin check does not help: non-browser clients send no Origin and `isOriginAllowed` returns true (line 14).
- **Fix:** Fail fast at startup — in `startHttpServer`, if `host` is not loopback (`127.0.0.1`/`::1`/`localhost`) and `MCP_TOKEN` is empty, `throw` before binding. Turns the documented rule into an enforced invariant.

## R2 — Non-constant-time comparison of bearer token enables timing attack
- **Severity:** Medium
- **file:line:** `src/httpServer.ts:59`
- **Problem:** `req.headers.authorization !== \`Bearer ${token}\`` uses JS string `!==`, which short-circuits on the first differing byte. An attacker reaching the endpoint can measure response-time differences to recover `MCP_TOKEN` byte-by-byte, defeating the only auth control guarding an RCE endpoint.
- **Fix:** Use `timingSafeEqual` from `node:crypto`. Build Buffers for the expected `Bearer ${token}` and received header, guard the length check against a random buffer to avoid leaking length, and reject on mismatch.

## R3 — Unbounded timeoutMs and no concurrency limit allow resource-exhaustion DoS
- **Severity:** Medium
- **file:line:** `src/server.ts:11-16`
- **Problem:** `timeoutMs` is validated only as a positive integer (agentInputSchema; run_all line 83), so a caller can pass a huge value to pin a spawned agent process open. No cap on concurrent invocations, and `run_all` spawns every adapter in parallel with no limit — repeated calls fork unbounded long-lived child processes (each a full coding-agent runtime), exhausting CPU/memory/PID.
- **Fix:** Clamp timeout to a hard max in `exec.ts`/`server.ts` (e.g. `MAX_TIMEOUT_MS ≈ 600_000`) and add a bounded concurrency gate (semaphore/queue) around the exec call so the endpoint cannot be driven into fork exhaustion.

## R4 — Agent stderr/stdout returned verbatim to caller leaks secrets and internals
- **Severity:** Low
- **file:line:** `src/server.ts:60`
- **Problem:** On non-zero exit the tool returns `result.stderr || result.stdout` directly to the MCP client (also `run_all` line 105). Coding-agent CLIs commonly print environment/config, absolute host paths, and on auth failures echo token/API-key fragments and stack traces. A caller can deliberately induce failures to harvest internal information (`OPENAI_API_KEY`/`ANTHROPIC_API_KEY`, host filesystem layout).
- **Fix:** Do not forward raw stderr. Return a generic failure message with exit code, log full stderr server-side (`console.error`), and redact known secret-shaped patterns before returning anything.

## R5 — Unvalidated cwd lets callers run agents in any directory on the host
- **Severity:** Low
- **file:line:** `src/server.ts:46-53`
- **Problem:** The caller-supplied `cwd` string is passed straight to `child_process.spawn` (server.ts:49 → exec.ts:21) with no validation/allowlist. In the Docker setup only `/workspace` is intended, but a caller can set `cwd` to any path (`/home/mcp/.codex`, `/`, mounted dirs), widening the blast radius.
- **Fix:** Add an optional allowlist (`MCP_ALLOWED_CWD` or configured workspace root). Resolve with `path.resolve` and reject any cwd outside an allowed root; default to the workspace root when unset.
