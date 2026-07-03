# 07 — Post-Filter Findings (false-positive filter + per-finding verification)

Each of the 26 raw findings was handed to an independent verification agent that judged whether the defect is `real`, assigned a confidence, and wrote a note. Tagging convention used here:

- **[CONFIRMED]** — verifier `real=true` with confidence ≥ 70.
- **[NEEDS-HUMAN]** — verifier `real=true` but confidence < 70 (real defect, but severity/reachability is a judgment call).
- **[UNVERIFIED]** — verifier `real=false` (filtered out: not reachable, intentional-and-documented, or capability already inside the trust boundary).

Tally: 19 CONFIRMED, 2 NEEDS-HUMAN, 5 UNVERIFIED (filtered out).

## CONFIRMED (19)

| Finding | file:line | Sev | Conf | Verifier note (summary) |
|---|---|---|---|---|
| Timeout kill leaves subprocess trees (Green G2) | src/exec.ts:29-32 | High | 88% | Spawn lacks detached/process-group; timeout kills only direct child; wrapped CLIs orphan grandchildren. detached:true + `process.kill(-child.pid)` fix correct. |
| Timeout orphans process tree (Arch A1) | src/exec.ts:29-32 | High | 85% | Same defect; docker runs as PID 1 with no init/tini, restart: unless-stopped, so leaked subtrees accumulate. |
| Unbounded buffering can OOM (Green G4) | src/exec.ts:24-25,41-42 | Medium | 80% | Output buffered unbounded, x4 under run_all; caller-controlled timeout. Byte-cap + kill + failure-path test appropriate. |
| Unbounded child buffering (Arch A4) | src/exec.ts:41-42 | Medium | 85% | Chunks accumulate with no cap; full string returned as one MCP block, no truncation. maxOutputBytes fix appropriate. |
| No concurrency cap / fork bomb (Arch A2) | src/httpServer.ts:32 (+exec.ts) | Medium | 85% | No semaphore/queue anywhere; run_all spawns 4 via Promise.allSettled; stateless POST. Exec-level semaphore covers both transports. |
| startHttpServer never rejects on listen failure (Green G3) | src/httpServer.ts:82-84 | Medium | 92% | Promise only resolves; no 'error' listener; EADDRINUSE/NaN PORT crashes raw, bypassing http.ts fatal handler. once('error', reject) fix correct. |
| Unpinned agent CLIs in runtime image (Green G5) | Dockerfile:18 | Medium | 88% | Global npm install floats 3 runtime-spawned CLIs to latest; non-reproducible, bypasses lockfile discipline, invisible to Dependabot. |
| npm publish ships stale/missing dist (Green G6) | package.json:7-15 | Medium | 80% | bin+files:[dist], dist gitignored, no prepublishOnly; fresh-clone publish ships broken bin. (Claim that local dist is currently stale is wrong — dist was rebuilt.) |
| CI never boots/smoke-tests Docker image (Green G7) | .github/workflows/ci.yml:58-61 | Medium | 85% | Docker job only builds/lists/prunes; CMD+HEALTHCHECK never exercised; runtime-stage regressions ship green. GHCR push optional. |
| run_all duplicates execution logic (Arch A3) | src/server.ts:86 | Medium | 80% | Per-agent handler and run_all duplicate buildInvocation→exec→format; already diverged (no model param, different error text). Shared runAdapter fix sound. Maintainability, not runtime bug. |
| Non-constant-time token — Red R2 | src/httpServer.ts:59 | Low | 72% | Plain `!==` (CWE-208) on the mandatory auth gate. Low practical exploitability (loopback default, sub-ns signal vs jitter). timingSafeEqual is standard. |
| Non-constant-time token — Green G9 | src/httpServer.ts:59 | Low | 70% | Same; reachable in documented TLS-proxy + MCP_TOKEN mode. Keep severity low. |
| Non-constant-time token — Security S2 | src/httpServer.ts:59 | Low | 70% | Same; length-check + timingSafeEqual on buffers, reject non-string headers. (R2/G9/S2 merged as one in Purple.) |
| HEALTHCHECK hardcodes port 3919 (Green G8) | Dockerfile:40-41 | Low | 85% | PORT is a supported override but healthcheck hardcodes 3919; overriding PORT flags a healthy container unhealthy. Mitigated by compose pinning PORT. |
| No test for MCP_ALLOWED_ORIGINS / malformed Origin (Green G10) | tests/http.test.ts:47-90 | Low | 80% | Allowlist branch + malformed-Origin catch have zero coverage. (Unknown-agent throw already covered in registry.test.ts:40-41, so that half is overstated.) |
| Zero observability for agent runs (Green G11) | src/server.ts:46-73 | Low | 75% | Handlers spawn credential-bearing subprocesses with no logging. Structured stderr log fix is stdio-safe. Ops enhancement, not a bug. |
| Version hardcoded, drifts (Arch A5) | src/server.ts:20 | Low | 78% | "0.1.0" duplicated in server.ts, package.json:3, docker-compose.yml:4. All match now — latent drift. Client-visible on initialize. |
| package.json omits claude agent — Green G12 | package.json:4 | Low | 92% | Description names only Codex/Cursor/OpenCode; registry.ts:9 registers claudeAdapter. Cosmetic metadata, one-line fix. |
| package.json omits claude agent — Arch A6 | package.json:4 | Low | 90% | Same; README already lists Claude, so only package.json needs the edit. (G12/A6 merged in Purple.) |

## NEEDS-HUMAN (2)

| Finding | file:line | Sev | Conf | Verifier note (summary) |
|---|---|---|---|---|
| RCE endpoint fail-open auth (Red R1) | src/httpServer.ts:27-64 | High→Medium | 65% | Code claims verified (fail-open MCP_TOKEN, absent-Origin bypass, Dockerfile HOST=0.0.0.0). But shipped defaults are safe (127.0.0.1; compose loopback-only) and the token requirement is documented, so exposure needs operator misconfig — though a bare `docker run -p 3919:3919` does yield unauthenticated network RCE with no code changes. Real hardening gap (CWE-306); downgrade High→Medium; fail-fast startup guard is the correct fix. |
| Unbounded timeoutMs + no concurrency DoS (Red R3) | src/server.ts:11-16 | Medium | 65% | No timeout cap and no concurrency limit confirmed. Two caveats: MAX_SAFE_INTEGER example is wrong (Node clamps >2^31-1 delays to ~1ms; real exposure is values up to ~24.8 days); reachability limited by loopback default + Origin checks + trusted stdio client. Real hardening gap (clamp timeout, add semaphore), severity low-to-medium not default-remote DoS. |

## UNVERIFIED — filtered out as false positives (5)

| Finding | file:line | Claimed Sev | Conf | Why dropped |
|---|---|---|---|---|
| Fork PRs execute code on self-hosted runners (Green G1) | .github/workflows/ci.yml:6 | High | 82% | Mechanics accurate but not reachable: repo is PRIVATE with 0 forks; fork-PR workflows disabled by default on private repos; collaborators already have equivalent push access. Latent-only; same-repo `if:` gate still worth adding as insurance if the repo goes public. |
| stderr/stdout returned verbatim leaks secrets (Red R4) | src/server.ts:60 | Low | 80% | Every tool already gives the caller arbitrary prompt+cwd control of full coding agents as the host user, so stderr forwarding adds no capability beyond the designed trust boundary; forwarding is also needed to surface auth/rate-limit errors. Defense-in-depth only. |
| Unvalidated cwd runs agents anywhere (Red R5) | src/server.ts:46-53 | Low | 72% | The equally caller-controlled prompt already lets agents reach any path the container user can; a cwd allowlist is a bypassable non-boundary. README documents the endpoint as shell-equivalent; free-form cwd is a documented feature for stdio mode. Optional hardening only. |
| Fail-open auth on RCE endpoint (Security S1) | src/httpServer.ts:58-64 | High | 72% | Posture is intentional and documented: compose publishes loopback-only with a warning, Dockerfile comment explains the in-container 0.0.0.0 bind, and docs/feature-plan/00-shape.md explicitly rejects fail-closed auth as disproportionate for a local single-user hub. Origin checks block DNS rebinding. Dropped per intentional+documented rule; fail-closed-on-non-loopback startup check remains a low/info suggestion. |
| Availability probing (I/O) in registry module (Arch A7) | src/registry.ts:42 | Low | 55% | Coupling claim overstated: registry uses type-only `import type { Exec }` (erased at runtime) with exec via DI, so no runtime infra dependency exists. Remaining cohesion concern is minor — refactor suggestion, no functional impact. |

**Merge/dedup summary:** the timing-attack finding was reported 3× (R2/G9/S2 → merged), the process-tree leak 2× (G2/A1), unbounded buffering 2× (G4/A4), the package.json description typo 2× (G12/A6), and the fail-open auth posture 2× (R1 kept as NEEDS-HUMAN with a severity downgrade; S1 dropped as intentional). After dedup and filtering, the surviving actionable set is what the Purple report (`09-purple.md`) prioritizes into P1/P2/P3.
