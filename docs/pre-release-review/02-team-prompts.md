# 02 — Team Roles / Charters

RE-REVIEW (round-2, post-hardening). The run journal records agent results, not the literal system prompts. The four review teams below are the roles actually used (identified by the `source` tag on every returned finding: `red`, `green`, `security`, `architecture`), plus the secret-scan and Purple reconciliation stages. Charters are summarized from the workflow definition. Because this is a re-review, teams were charged with re-checking the round-1 fixes (confirmed fixed, not re-reported) and reporting only residual/new issues.

## Secret Scan (pre-gate)
Runs `gitleaks` over full git history and the working tree before any team starts. Blocks the review if any credential, key, or `.env`/`.pem`/`.key` file is found. Result this run: CLEAN (gitleaks git + filesystem, exit 0; the only regex matches were the literal word "secret" in report files, no credential values).

## Red (adversarial)
Attacker's mindset. Hunts for exploitable behavior — RCE surfaces, auth bypass, injection, side channels, resource-exhaustion / DoS, and information leakage — and describes a concrete attack path plus a fail-fast fix for each. Produced 5 findings (fail-open auth/RCE, Origin-allowlist-is-not-auth, unbounded semaphore waiter DoS, unvalidated cwd, unbounded timeoutMs).

## Green + DevOps (quality & delivery)
Correctness, reliability, testability, and the build/CI/release pipeline. Covers error handling, resource leaks, CI configuration, Docker/runtime image hygiene, dependency pinning, publish safety, healthchecks, observability, and test-coverage gaps. Produced 6 findings (no retained/GHCR image, no SIGTERM/graceful drain, Node PID 1 no init, host-wide docker prune, no lint gate, engines node>=20 vs 22).

## Security-CSO (OWASP + STRIDE)
Formal security lens: OWASP Top 10 and STRIDE threat modeling on the trust boundary, with emphasis on secure-by-default posture and whether documented mitigations are enforced controls or just guidance. Produced 1 finding (fail-open auth on the RCE endpoint shipped with HOST=0.0.0.0 and no fail-closed startup guard), corroborating Red's auth finding.

## Architecture (structural)
Layering, cohesion/coupling, single-source-of-truth, duplication, and scalability bottlenecks. Flags design debt that forces future fixes to land in multiple places and structural single-points-of-failure. Produced 5 findings (run_all never sets isError, semaphore no acquire timeout/queue bound/fast-fail, list_agents probe competes for the execution semaphore, docker-compose image tag hardcodes version, checkAvailability I/O in the pure registry module).

## Purple (reconciliation)
Consumes all team findings after the false-positive filter, deduplicates cross-team overlaps (here: Red R1 + Security S1 merged into P1.1), assigns P1/P2/P3 priority, and issues the final SHIP / NO-SHIP verdict with a path-to-ship. Result this run: DO-NOT-SHIP (80%).
