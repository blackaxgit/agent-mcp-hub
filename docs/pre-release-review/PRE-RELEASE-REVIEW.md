# Pre-Release Review — agent-mcp-hub

## Verdict: DO NOT SHIP (confidence 80%)

- **Secret scan (GitLeaks):** CLEAN — full history (34 commits) + working tree, 0 leaks.
- **Codex status:** completed (independent cross-check ran; folded into Purple).
- **Last completed step:** Step 7 (final report).
- No critical vulnerabilities. The block is one confirmed high-severity resource-leak in the sole execution path plus a compounding resource-exhaustion pair that degrade/crash the long-lived Docker deployment under normal failure modes. Blocking fixes are small (a few hours); re-review of P1 + top P2s flips this to SHIP.

### Top 3 blockers
1. Timeout SIGKILL orphans wrapped-CLI subprocess trees (`src/exec.ts:29-32`) — leaks CPU/memory/API credits on every timeout in the PID-1 `restart: unless-stopped` container.
2. Resource-exhaustion pair — unbounded child-output buffering (`src/exec.ts:24-25,41-42`) + no agent-spawn concurrency cap (`src/httpServer.ts:32`): a burst or verbose agent OOMs/fork-bombs the hub.
3. Agent CLIs installed unpinned in the runtime image (`Dockerfile:18`) — non-reproducible builds, silent supply-chain drift, invisible to Dependabot.

### Stage files
`00-secrets.md` · `00-gitleaks.json` · `01-approach.md` · `02-team-prompts.md` · `03-red.md` · `04-green.md` · `05-security.md` · `06-architecture.md` · `07-filtered.md` · `08-codex.md` · `09-purple.md`

---

## P1 — Must fix before release

- [ ] **Timeout kill leaves agent subprocess trees running**
  File: `src/exec.ts:29-32`
  Problem: `child.kill("SIGKILL")` signals only the direct child; wrapped CLIs (codex/claude/cursor-agent/opencode) spawn subprocess trees whose grandchildren are orphaned on every timeout, accumulating in the PID-1, `restart: unless-stopped` Docker deployment (leaked CPU/memory/API credits).
  Fix: spawn with `detached: true`; on timeout kill the group via `process.kill(-child.pid, "SIGKILL")` with fallback to `child.kill`; add a grandchild-survivor test.
  Severity: high · Effort: S · Source: [multiple] (green+architecture, 88%/85%) · Status: [CONFIRMED]

## P2 — Should fix before release

- [ ] **Unbounded stdout/stderr buffering can OOM the hub**
  File: `src/exec.ts:24-25,41-42`
  Problem: all child output is buffered in memory with no cap; a looping/dumping agent (×4 under `run_all`) exhausts the Node heap and crashes the whole server.
  Fix: add `maxOutputBytes` (~10 MiB default); on breach kill the process group and reject with an actionable error + truncation marker; add a failure-path test.
  Severity: medium · Effort: S · Source: [multiple] (green+architecture, 80%/85%) · Status: [CONFIRMED]

- [ ] **No concurrency cap on agent spawns**
  File: `src/httpServer.ts:32` (+ `src/exec.ts`)
  Problem: each POST /mcp spawns up to 4 heavyweight CLIs statelessly with no queue/semaphore; N requests = N×4 concurrent processes exhausting PIDs/memory (no auth if `MCP_TOKEN` unset).
  Fix: in-process semaphore in `exec.ts` (`MAX_CONCURRENT_AGENTS`, env-overridable, default ~4) that queues or fast-fails with "server busy".
  Severity: medium · Effort: M · Source: [architecture] (85%) · Status: [CONFIRMED]

- [ ] **startHttpServer never rejects on listen failure**
  File: `src/httpServer.ts:82-84`
  Problem: the promise only resolves; EADDRINUSE/EACCES/NaN PORT emits an unhandled `'error'`, crashing with a raw stack and bypassing the fatal handler at `http.ts:14-17`.
  Fix: `httpServer.once("error", reject)` before `listen`, removed on success; validate PORT range in `src/http.ts:4`.
  Severity: medium · Effort: S · Source: [green] (92%) · Status: [CONFIRMED]

- [ ] **Agent CLIs installed unpinned in runtime image**
  File: `Dockerfile:18`
  Problem: global `npm install -g` floats codex/opencode/claude to latest — non-reproducible builds, silent supply-chain drift, bypasses lockfile discipline.
  Fix: pin exact versions (`@x.y.z`) or move to a tracked package.json so Dependabot proposes bumps.
  Severity: medium · Effort: S · Source: [green] (88%) · Status: [CONFIRMED]

- [ ] **npm publish would ship stale/missing dist**
  File: `package.json:7-15`
  Problem: `files: ["dist"]` but `dist/` is gitignored and there's no prepare/prepublishOnly script — publishing from a fresh clone ships a broken package (latent until first publish).
  Fix: add `"prepublishOnly": "npm run build && npm test"`.
  Severity: medium · Effort: S · Source: [green] (80%) · Status: [CONFIRMED]

- [ ] **CI never boots or smoke-tests the Docker image**
  File: `.github/workflows/ci.yml` (docker job)
  Problem: the docker job only builds/lists/prunes; a broken CMD, missing runtime dep, or PATH regression ships green.
  Fix: run the image in CI, poll `curl -fsS :3919/healthz` with retry, teardown in `if: always()`; GHCR push optional.
  Severity: medium · Effort: M · Source: [green] (85%) · Status: [CONFIRMED]

- [ ] **run_all duplicates per-agent execution logic (already diverged)**
  File: `src/server.ts:86`
  Problem: `run_all` reimplements buildInvocation→exec→format and has diverged (no `model` param, different error text); every exec-path fix must land twice — the P1/P2 exec fixes would otherwise miss this path.
  Fix: extract a shared `runAdapter()` helper used by both handlers; add optional `model` passthrough to `run_all`.
  Severity: medium · Effort: M · Source: [architecture] (80%) · Status: [CONFIRMED]

## P3 — Nice to have

- [ ] **Non-constant-time bearer-token comparison** — `src/httpServer.ts:59`: plain `!==` on `Bearer ${token}` is variable-time (CWE-208) on the sole auth gate; exploitability low (loopback default, network jitter swamps signal). Fix: sha256 both sides + `crypto.timingSafeEqual`; reject non-string headers. Severity: low · Effort: S · Source: [multiple] (red+green+security, 70-72%) · Status: [CONFIRMED]
- [ ] **HEALTHCHECK hardcodes port 3919** — `Dockerfile:40-41`: ignores `PORT` env, so an override restart-loops a healthy container. Fix: shell-form `CMD curl -fsS "http://localhost:${PORT:-3919}/healthz" || exit 1`. Severity: low · Effort: S · Source: [green] (85%) · Status: [CONFIRMED]
- [ ] **No tests for MCP_ALLOWED_ORIGINS / malformed Origin** — `tests/http.test.ts`: allowlist branch + malformed-Origin catch (`httpServer.ts:15-24`) uncovered. Fix: add allowlist-pass, allowlist-block, `origin:"not-a-url"`→403 tests. Severity: low · Effort: S · Source: [green] (80%) · Status: [CONFIRMED]
- [ ] **Zero observability for spawned agent runs** — `src/server.ts:46-73`: no record of agent/cwd/duration/exit code. Fix: one structured `console.error(JSON.stringify(...))` per invocation (stderr-only, stdio-safe). Severity: low · Effort: S · Source: [green] (75%) · Status: [CONFIRMED] — NOTE: Feature 3 (in-flight) adds exactly this via audit events.
- [ ] **Server version hardcoded, drifts from package.json** — `src/server.ts:20`: "0.1.0" duplicated across server.ts/package.json/compose. Fix: read from package.json via `createRequire`. Severity: low · Effort: S · Source: [architecture] (78%) · Status: [CONFIRMED] — NOTE: Feature 3 config work is the natural home.
- [ ] **package.json description omits the claude agent** — `package.json:4`: lists only Codex/Cursor/OpenCode though claudeAdapter ships enabled. Fix: add "…and Claude". Severity: low · Effort: S · Source: [multiple] (green+architecture, 92%/90%) · Status: [CONFIRMED]

## Notes
- 19 findings CONFIRMED, per-finding confidence 70–92%; none rest on unverified claims. Dedup: timing-attack (3 teams), process-tree leak / unbounded buffering / description typo (2 teams each).
- Path to SHIP: fix P1 (process-group kill) + P2 items 2–5; items 6–8 can ride the next patch. Total effort small, all localized.
- Overlap with in-flight Feature 3 (template alignment): P3 observability and version-drift are already in that feature's scope; the P1/P2 exec + concurrency fixes are NOT and should be a dedicated hardening pass.
- Read-only review: no application code modified.
