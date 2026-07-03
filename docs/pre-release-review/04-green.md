# 04 — Green + DevOps (quality & delivery findings)

12 findings, raw (pre-filter). Verification outcomes are cross-referenced in `07-filtered.md`.

## G1 — Fork PRs execute arbitrary code on self-hosted runners
- **Severity:** High
- **file:line:** `.github/workflows/ci.yml:6`
- **Problem:** The unrestricted `pull_request:` trigger runs `npm ci` + `npm test` on `self-hosted` runners. npm lifecycle scripts and test code from any PR (including forks if the repo becomes public) execute on the runner host, which also has Docker daemon access (`DOCKER_HOST`) — full runner compromise and image poisoning from a single malicious PR.
- **Fix:** Gate PR jobs to same-repo PRs: `if: github.event.pull_request.head.repo.full_name == github.repository || github.event_name == 'push'` on the `secrets`/`test` jobs (or move PR builds to GitHub-hosted runners). Also require approval for fork PR workflows.

## G2 — Timeout kill leaves agent subprocess trees running
- **Severity:** High
- **file:line:** `src/exec.ts:29-32`
- **Problem:** `child.kill("SIGKILL")` signals only the direct child. Wrapped CLIs (codex, claude, cursor-agent) spawn their own subprocess trees; on timeout those grandchildren are orphaned and keep burning CPU, tokens, and file handles indefinitely. Every timed-out `run_all` can leak up to 4 process trees.
- **Fix:** Spawn with `detached: true` and kill the whole group: `try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }`. Add a test that a child spawning a grandchild leaves no survivors after timeout.

## G3 — startHttpServer never rejects on listen failure (EADDRINUSE crashes uncaught)
- **Severity:** Medium
- **file:line:** `src/httpServer.ts:82-84`
- **Problem:** The returned promise only ever resolves. If `listen` fails (port in use, `Number("abc") = NaN`, privileged port), the server emits an unhandled `'error'` event → uncaught exception that bypasses the intended fatal handler at `http.ts:14-17`, producing a raw stack and skipping cleanup.
- **Fix:** Wire the error path before listen: `httpServer.once("error", reject); httpServer.listen(port, host, () => { httpServer.removeListener("error", reject); resolve(httpServer); });`. Also validate PORT in `src/http.ts:4`.

## G4 — Unbounded stdout/stderr buffering can OOM the hub
- **Severity:** Medium
- **file:line:** `src/exec.ts:24-25,41-42`
- **Problem:** All child output is accumulated in memory with no cap. An agent CLI that loops or dumps large files can emit gigabytes within the 300s default timeout; with `run_all` this is multiplied by 4 concurrent agents, exhausting the Node heap and killing the whole server.
- **Fix:** Track accumulated byte length; past a cap (`opts.maxOutputBytes ?? 10 * 1024 * 1024`) kill the process group and reject with `"<binary> exceeded output limit of N bytes"`. Add a failure-path test.

## G5 — Agent CLIs installed unpinned in the runtime image
- **Severity:** Medium
- **file:line:** `Dockerfile:18`
- **Problem:** `npm install -g @openai/codex opencode-ai @anthropic-ai/claude-code` floats to latest on every build. Non-reproducible images, a compromised/broken upstream release silently enters the runtime image, and Dependabot does not track global installs — bypassing the lockfile discipline used elsewhere (all 199 lockfile entries are registry-pinned with integrity hashes).
- **Fix:** Pin exact versions (`@x.y.z`) and document the bump procedure, or move them into a tracked package.json so Dependabot proposes updates.

## G6 — npm publish would ship stale or missing dist (no prepublish build)
- **Severity:** Medium
- **file:line:** `package.json:7-15`
- **Problem:** The package declares `bin` and `files: ["dist"]`, but `dist/` is gitignored and there is no `prepare`/`prepublishOnly` script. `npm publish` from a fresh clone publishes a broken package (no dist); from a dev machine it publishes whatever stale build is on disk.
- **Fix:** Add `"prepublishOnly": "npm run build && npm test"` (or `"prepare": "npm run build"` if git-install support is wanted).

## G7 — CI builds the Docker image but never boots or smoke-tests it
- **Severity:** Medium
- **file:line:** `.github/workflows/ci.yml:58-61`
- **Problem:** The docker job runs `docker build`, `docker image ls`, then prunes. Nothing verifies the container starts, binds the port, or answers `/healthz` — a broken CMD, missing runtime dep, or PATH regression ships green. The image is never pushed, so a passing docker job produces no deployable artifact or rollback target.
- **Fix:** After build: `docker run -d --name hub-ci -p 127.0.0.1:3919:3919 agent-mcp-hub:ci`, poll `curl -fsS http://127.0.0.1:3919/healthz` with a ~30s retry loop, `docker rm -f hub-ci` in an `if: always()` step. Optionally push tagged builds to GHCR.

## G8 — HEALTHCHECK hardcodes port 3919, breaks if PORT is overridden
- **Severity:** Low
- **file:line:** `Dockerfile:40-41`
- **Problem:** `HEALTHCHECK ... curl http://localhost:3919/healthz` ignores the configurable `PORT` env. Running with a different PORT makes the healthcheck fail permanently — the container is flagged unhealthy and orchestrators restart-loop a working server.
- **Fix:** Use the env var in a shell-form healthcheck: `CMD curl -fsS "http://localhost:${PORT:-3919}/healthz" || exit 1`.

## G9 — Bearer token compared with non-constant-time string equality
- **Severity:** Low
- **file:line:** `src/httpServer.ts:59`
- **Problem:** `req.headers.authorization !== \`Bearer ${token}\`` is variable-time, leaking token prefix length/content via response timing. Low practical exploitability on loopback, but this endpoint is explicitly designed to be reverse-proxied to a network where `MCP_TOKEN` is the only auth.
- **Fix:** Hash both sides and use `crypto.timingSafeEqual`: compare `sha256(header)` against `sha256("Bearer " + token)` so lengths always match, returning 401 on mismatch.

## G10 — No test coverage for MCP_ALLOWED_ORIGINS or startup rejection on bad MCP_AGENTS
- **Severity:** Low
- **file:line:** `tests/http.test.ts:47-90`
- **Problem:** Two documented behaviors are untested: (1) the `MCP_ALLOWED_ORIGINS` allowlist in `isOriginAllowed` (src/httpServer.ts:15-19) including the malformed-Origin catch path; (2) `startHttpServer` rejecting before bind when `MCP_AGENTS` contains an unknown agent. Regressions in either ship silently.
- **Fix:** Add tests: set `MCP_ALLOWED_ORIGINS="https://ide.example.com"` and assert it passes (405 not 403) while others 403, plus malformed `origin: "not-a-url"` → 403; and `await expect(startHttpServer(0)).rejects.toThrow(/Unknown agent/)` with `MCP_AGENTS="typo"` (restore env in finally).

## G11 — Zero observability for spawned agent runs
- **Severity:** Low
- **file:line:** `src/server.ts:46-73`
- **Problem:** Tool handlers spawn long-running, credential-bearing agent processes with no logging (the only log line is the HTTP 500 handler). No record of which agent ran, cwd, duration, or exit code — diagnosing hangs, timeouts, or cost blowups requires guesswork.
- **Fix:** Log one structured line per invocation to stderr (never stdout): `console.error(JSON.stringify({ agent, cwd, ms, exitCode }))` on completion/failure in the agent and `run_all` handlers.

## G12 — package.json description omits the claude agent
- **Severity:** Low
- **file:line:** `package.json:4`
- **Problem:** Description reads "bridging the Codex, Cursor, and OpenCode CLI agents" but the hub also ships the claude adapter (`src/registry.ts:9`). Misleading in npm listings.
- **Fix:** Update to "One MCP server bridging the Codex, Cursor, OpenCode, and Claude CLI agents".
