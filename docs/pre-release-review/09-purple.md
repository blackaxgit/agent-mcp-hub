# 09 — Purple Team (reconciled verdict)

## Verdict: DO-NOT-SHIP (confidence: 80%)

Secret scan: CLEAN (gitleaks over full history + working tree; no leaks, no stray key/env files). No critical vulnerabilities. However, one confirmed high-severity resource-leak defect in the sole execution path, plus a compounding resource-exhaustion pair, make the long-lived Docker deployment degrade or crash under normal failure modes. The blocking fixes are small (est. a few hours total); re-review of P1 + top P2s should flip this to SHIP.

## Top 3 Blockers

1. **Timeout kill orphans agent subprocess trees** — `src/exec.ts:29-32`. `child.kill("SIGKILL")` hits only the direct child; wrapped CLIs (codex, claude, cursor-agent, opencode) leave grandchildren running, leaking CPU/memory/API credits on every timeout in the long-lived hub. Confirmed independently by two teams (88% / 85%).
2. **Resource exhaustion pair: unbounded output buffering + no concurrency cap** — `src/exec.ts:24-25,41-42` and `src/httpServer.ts:32`. All child output accumulates uncapped in memory, and each POST `/mcp` can spawn up to 4 concurrent agent CLIs with no semaphore; a burst or verbose agent OOMs/fork-bombs the entire hub, killing all in-flight requests.
3. **Agent CLIs installed unpinned in runtime image** — `Dockerfile:18`. `npm install -g` floats three third-party, runtime-spawned CLIs to latest on every build: non-reproducible images, silent ingestion of broken/compromised releases, invisible to Dependabot.

## P1 — Must fix before release

| # | Finding | file:line | Problem | Fix | Sev | Source |
|---|---|---|---|---|---|---|
| 1 | Timeout kill leaves agent subprocess trees running | src/exec.ts:29-32 | SIGKILL signals only the direct child; wrapped CLIs spawn subprocess trees that get orphaned on every timeout, accumulating in the PID-1, restart-unless-stopped Docker deployment | Spawn with `detached: true`; kill the group via `process.kill(-child.pid, "SIGKILL")` with fallback to `child.kill`; add a grandchild-survivor test | High | green + architecture (88% / 85%) |

## P2 — Should fix before release

| # | Finding | file:line | Problem | Fix | Sev | Source |
|---|---|---|---|---|---|---|
| 2 | Unbounded stdout/stderr buffering can OOM the hub | src/exec.ts:24-25,41-42 | All child output buffered in memory with no cap; a looping/dumping agent (x4 under run_all) exhausts the Node heap and crashes the whole server | Add `maxOutputBytes` (~10 MiB default); on breach kill the process group and reject with an actionable error + truncation marker; add failure-path test | Medium | green + architecture (80% / 85%) |
| 3 | No concurrency cap on agent spawns | src/httpServer.ts:32 (+ src/exec.ts) | Each POST /mcp spawns up to 4 heavyweight CLIs statelessly with no queue/semaphore; N requests = N*4 concurrent processes, exhausting PIDs/memory (no auth if MCP_TOKEN unset) | In-process semaphore in exec.ts (`MAX_CONCURRENT_AGENTS`, env-overridable, default ~4) that queues or fast-fails with "server busy" | Medium | architecture (85%) |
| 4 | startHttpServer never rejects on listen failure | src/httpServer.ts:82-84 | Promise only resolves; EADDRINUSE/EACCES/NaN PORT emits unhandled 'error', crashing with a raw stack and bypassing the intended fatal handler at http.ts:14-17 | `httpServer.once("error", reject)` before `listen`, remove on success; validate PORT range in src/http.ts:4 | Medium | green (92%) |
| 5 | Agent CLIs installed unpinned in runtime image | Dockerfile:18 | Global npm install floats to latest: non-reproducible builds, silent supply-chain drift, bypasses the repo's lockfile discipline | Pin exact versions (`@x.y.z`) or move to a tracked package.json so Dependabot proposes bumps | Medium | green (88%) |
| 6 | npm publish ships stale/missing dist | package.json:7-15 | `files: ["dist"]` but dist/ is gitignored and no prepare/prepublishOnly script exists — publish from a fresh clone ships a broken package (latent until first publish) | Add `"prepublishOnly": "npm run build && npm test"` | Medium | green (80%) |
| 7 | CI never boots or smoke-tests the Docker image | .github/workflows/ci.yml:58-61 | Docker job only builds/lists/prunes; broken CMD, missing runtime dep, or PATH regression ships green | Run the image in CI, poll `curl -fsS :3919/healthz` with retry, teardown in `if: always()`; GHCR push optional | Medium | green (85%) |
| 8 | run_all duplicates per-agent execution logic, no model override | src/server.ts:86 | run_all reimplements buildInvocation→exec→format and has already diverged (no `model` param, different error text); every exec-path fix must land twice | Extract shared `runAdapter()` helper used by both handlers; add optional model passthrough to run_all schema | Medium | architecture (80%) |

## P3 — Nice to fix

| # | Finding | file:line | Problem | Fix | Sev | Source |
|---|---|---|---|---|---|---|
| 9 | Non-constant-time bearer-token comparison | src/httpServer.ts:59 | Plain `!==` on `Bearer ${token}` is variable-time (CWE-208) on the sole auth gate for an RCE-capable endpoint; practical exploitability low (loopback default, jitter swamps signal) | Hash both sides (sha256) and compare with `crypto.timingSafeEqual`; reject non-string headers | Low (verifiers downgraded from medium) | red + green + security (70-72%) |
| 10 | HEALTHCHECK hardcodes port 3919 | Dockerfile:40-41 | Ignores the supported PORT env; overriding PORT makes a healthy container flagged unhealthy and restart-looped | Shell-form: `CMD curl -fsS "http://localhost:${PORT:-3919}/healthz" \|\| exit 1` | Low | green (85%) |
| 11 | No tests for MCP_ALLOWED_ORIGINS / malformed Origin | tests/http.test.ts:47-90 | Allowlist branch and malformed-Origin catch path (src/httpServer.ts:15-24) have zero coverage; regressions ship silently (Unknown-agent throw already unit-covered in registry.test.ts) | Add allowlist-pass, allowlist-block, and `origin: "not-a-url"` → 403 tests | Low | green (80%) |
| 12 | Zero observability for spawned agent runs | src/server.ts:46-73 | No record of agent, cwd, duration, or exit code; diagnosing hangs/cost blowups in Docker is guesswork | One structured `console.error(JSON.stringify({agent, cwd, ms, exitCode}))` per invocation (stderr only, stdio-safe) | Low | green (75%) |
| 13 | Server version hardcoded, drifts from package.json | src/server.ts:20 | "0.1.0" duplicated in server.ts, package.json, docker-compose.yml; next release silently desyncs the MCP-advertised version | Read version from package.json via `createRequire` (or inject at build) | Low | architecture (78%) |
| 14 | package.json description omits the claude agent | package.json:4 | Lists only Codex/Cursor/OpenCode though claudeAdapter ships enabled (src/registry.ts:9); stale npm metadata | Update to "...Codex, Cursor, OpenCode, and Claude CLI agents" | Low | green + architecture (92% / 90%) |

## Notes

- **Deduplication:** the timing-attack finding was reported by 3 teams (merged, item 9); process-tree leak, unbounded buffering, and the description typo were each reported by 2 teams (merged, items 1, 2, 14).
- **Verification:** all findings promoted to the P1/P2/P3 tables were verified CONFIRMED with per-finding confidence 70-92%. Findings dropped by the false-positive filter (fork-PR RCE on a private repo, verbatim stderr, unvalidated cwd, the intentional fail-open posture, and the registry cohesion nit) are recorded in `07-filtered.md`; the two NEEDS-HUMAN items (Red R1 fail-open severity downgrade, Red R3 DoS reachability) did not gate the verdict.
- **Independent cross-check:** no distinct Codex stage ran (see `08-codex.md`) — independent-verification confidence is correspondingly reduced.
- **Path to SHIP:** fix item 1 (P1) plus items 2-5; items 6-8 can ride the next patch. Estimated total effort: small — all fixes are localized.

**Recommendation:** fix P1 (process-group kill in `src/exec.ts`) first, bundle P2 items 2-3 into the same exec.ts change, then re-run tests and request a focused re-review of the exec path before tagging the release.
