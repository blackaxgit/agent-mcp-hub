# Fix Plan — pre-release hardening

Design constraints: no new runtime deps; adapters stay pure (only `exec.ts` spawns); audit/log to stderr only (C5); TDD (failing test first) for every behavioral fix. Grouped by file for disjoint agent ownership.

## Group A — `src/exec.ts` (#1 tree-kill, #2 output cap, #3 semaphore) — FOUNDATIONAL, done first
- Spawn with `detached: true` (child becomes group leader). Do NOT `unref()` (we await output).
- Replace `child.kill("SIGKILL")` with `killTree(child)`: `try { process.kill(-child.pid, "SIGKILL") } catch (ESRCH) {} ` + fallback `child.kill("SIGKILL")`. Used by timeout AND output-cap breach.
- Add `maxOutputBytes` opt (default `10 * 1024 * 1024`). Track running byte count across stdout+stderr chunks; on breach set `killedForOutput=true`, `killTree`, and on close reject with `"<binary> exceeded output limit of Nmb"` (never echo captured bytes).
- Add module-level async semaphore `withSlot<T>(fn)`: `MAX_CONCURRENT_AGENTS` (default 4, `process.env.MCP_MAX_CONCURRENT_AGENTS` override, parsed once). `runCommand` acquires a slot before spawn, releases in `finally`. Queue is FIFO; no fast-fail (queue) to keep behavior simple and correct.
- `Exec` type gains `maxOutputBytes?`. Signatures otherwise unchanged (backward compatible).
- Tests (`tests/exec.test.ts`): (a) grandchild-survivor — spawn `node -e` that forks a `setTimeout` grandchild writing a marker file; timeout; assert grandchild dead (poll marker not updated) — Linux/macOS process-group. (b) output-cap — child dumps > limit; assert reject with limit message and process killed. (c) semaphore — launch N>cap slow spawns; assert no more than cap run concurrently (instrument via a shared counter through an injected fake, or count live PIDs). Keep existing 6 tests green.

## Group B — `src/server.ts` (#8 runAdapter, #12 observability, #13 version) — deps A
- Extract `async function runAdapter(adapter, exec, {prompt, model, cwd, timeoutMs}, auditLog): Promise<ExecResult>` wrapping buildInvocation→exec with timing; emit ONE structured line to stderr per call: `console.error(JSON.stringify({evt:"agent_run", agent, cwd, ms, exitCode}))` (NO prompt/output). Both the per-agent handler and run_all call it → single source (#8), so run_all inherits model support + all exec-path fixes.
- Add optional `model` to run_all inputSchema, passed through.
- Version: `createRequire(import.meta.url)("../package.json").version` → McpServer version (#13). (tsconfig `resolveJsonModule` not needed via createRequire.)
- Tests: run_all now forwards `model`; version test reads package.json; observability — capture stderr writes, assert one JSON line/call with no prompt text.

## Group C — `src/httpServer.ts` (#4 listen-reject, #9 timing-safe) — deps A (independent of B)
- Before `listen`: `httpServer.once("error", reject)`; on `listening` remove it and resolve.
- Token check: `const expected = Buffer.from(sha256(\`Bearer ${token}\`)); const got = Buffer.from(sha256(String(req.headers.authorization ?? "")));` compare via `crypto.timingSafeEqual(expected, got)` (equal-length by hashing). Reject non-string auth.
- Tests (`tests/http.test.ts`): (a) listen on an already-bound port → promise rejects (#4). (b) origin allowlist pass + block + malformed-Origin→403 (#11). Token tests still pass (behavior unchanged, timing-safe).

## Group D — `Dockerfile` (#5 pin, #10 healthcheck) — independent
- Pin: `npm install -g @openai/codex@<v> opencode-ai@<v> @anthropic-ai/claude-code@<v>` (exact latest published versions resolved at implementation via `npm view <pkg> version`), with a comment that Dependabot's docker ecosystem won't track these — bump manually or via a tracked manifest later.
- HEALTHCHECK → shell-form: `CMD curl -fsS "http://localhost:${PORT:-3919}/healthz" || exit 1`.

## Group E — `package.json` (#6 prepublishOnly, #14 description) — independent
- `"prepublishOnly": "npm run build && npm test"`.
- Description → "...Codex, Cursor, OpenCode, and Claude CLI agents".

## Group F — `.github/workflows/ci.yml` (#7 image smoke) — independent
- After build: `docker run -d --name hub -p 3919:3919 agent-mcp-hub:ci`; poll `curl -fsS localhost:3919/healthz` with retry (≤10× sleep 2); `docker rm -f hub` in `if: always()`; then the existing prune.

## Regression-test summary
Every behavioral fix (#1,#2,#3,#4,#8,#9,#11,#12,#13) ships a test that fails pre-fix, passes post-fix. #5,#6,#7,#10,#14 are config/CI/text — verified by inspection + (for #7) the CI run itself.

## Not symptom patches
#1 fixes the process-group invariant, not "kill harder". #8 removes the duplication that would let #1/#2 half-land. #3/#2 bound the two unbounded resources structurally. #4 restores the listen error contract.
