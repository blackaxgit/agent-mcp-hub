# 02 — Team Roles / Charters

The run journal records agent results, not the literal system prompts. The four review teams below are the roles actually used (identified by the `source` tag on every returned finding: `red`, `green`, `security`, `architecture`), plus the secret-scan and Purple reconciliation stages. Charters are summarized from the workflow definition.

## Secret Scan (pre-gate)
Runs `gitleaks` over full git history and the working tree before any team starts. Blocks the review if any credential, key, or `.env`/`.pem`/`.key` file is found. Result this run: CLEAN.

## Red (adversarial)
Attacker's mindset. Hunts for exploitable behavior — RCE surfaces, auth bypass, injection, side channels, resource-exhaustion / DoS, and information leakage — and describes a concrete attack path plus a fail-fast fix for each. Produced 5 findings.

## Green + DevOps (quality & delivery)
Correctness, reliability, testability, and the build/CI/release pipeline. Covers error handling, resource leaks, CI configuration, Docker/runtime image hygiene, dependency pinning, publish safety, healthchecks, observability, and test-coverage gaps. Produced 12 findings (largest team output).

## Security-CSO (OWASP + STRIDE)
Formal security lens: OWASP Top 10 and STRIDE threat modeling on the trust boundary, with emphasis on secure-by-default posture and whether documented mitigations are enforced controls or just guidance. Produced 2 findings (both on the auth path).

## Architecture (structural)
Layering, cohesion/coupling, single-source-of-truth, duplication, and scalability bottlenecks. Flags design debt that forces future fixes to land in multiple places and structural single-points-of-failure. Produced 7 findings.

## Purple (reconciliation)
Consumes all team findings after the false-positive filter, deduplicates cross-team overlaps, assigns P1/P2/P3 priority, and issues the final SHIP / NO-SHIP verdict with a path-to-ship. Result this run: DO-NOT-SHIP (80%).
