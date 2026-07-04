# Scope Shape — Dependabot PR triage (round 3)

## Request
"Merge the open PRs and ensure it will not break the project." Four open Dependabot PRs:
- #8 docker: node 22 → 25-bookworm-slim (MAJOR base image)
- #9 dev: tsx 4.22.5 → 4.23.0 (minor group)
- #10 dev: @eslint/js 9.39.4 → 10.0.1 (MAJOR)
- #11 dev: eslint 9.39.4 → 10.6.0 (MAJOR)

## Chosen mode: Reduction
This is dependency triage, not a feature. Merge only the bumps that PROVABLY don't break the project (empirical gate); close/hold those that break or violate policy. Skip the heavy spec ceremony — the certainty source for dep bumps is the full gate (test + lint + format + typecheck + build + stdio smoke), not plan review.

## Merge gate (empirical, per PR + combined)
A PR merges only if, in an isolated worktree merged against CURRENT main: `npm ci && npm test && npm run lint && npm run format:check && npm run typecheck && npm run build` all pass, plus the stdio initialize smoke.

## Per-PR disposition (to be confirmed by verification)
- **#9 tsx** — minor dev-tool bump; expected SAFE → merge.
- **#11 eslint 10 + #10 @eslint/js 10** — INTERDEPENDENT majors (eslint and @eslint/js must share a major); verify TOGETHER in one worktree. RISK: typescript-eslint 8.x peer-supports eslint ^8.57 || ^9 — ESLint 10 may be outside its range, breaking `npm run lint`. If lint breaks, HOLD both until typescript-eslint ships eslint-10 support (don't merge one without the other). Merge both only if the full gate (esp. lint) passes.
- **#8 node 25** — MAJOR base image to a NON-LTS release. Policy: this repo already closed #1 (node 26) for LTS-only. Node 25 is a current/odd (non-LTS) line; engines>=22 allows it but LTS discipline says no. Disposition: CLOSE with a Dependabot major-version ignore, same as #1. (Node 24 is the LTS; a targeted 22→24 bump can be proposed separately if desired.)

## Explicitly NOT doing
- Not merging a bump that fails any gate "to fix later".
- Not merging #8 (non-LTS) — closed by policy.
- Not merging #11/#10 individually (would desync eslint/@eslint/js majors).

## Riskiest assumption
That typescript-eslint 8 works with ESLint 10 — resolved empirically by the worktree verification before any merge.

## Outcome (2026-07-03)
- Isolated-worktree verification, full gate (test+lint+format+typecheck+build+stdio smoke) each PASS.
- **Decisive finding:** typescript-eslint 8.62.1 peer range is `eslint ^8.57 || ^9 || ^10` — ESLint 10 explicitly supported; `npm run lint` clean under ESLint 10 (no flat-config/rule-schema breakage), 0 peer/engine warnings.
- **Merged:** #9 tsx 4.23.0; #11 eslint 10.6.0 + #10 @eslint/js 10.0.1 (the interdependent pair — #11 merged, #10 Dependabot-rebased to regenerate its lock against eslint-10 main, then merged green).
- **Closed:** #8 node 25 — non-LTS base image, per the LTS-only policy (precedent #1/node 26), with a Dependabot major-ignore.
- **Merged main re-verified locally:** eslint 10.6.0 + @eslint/js 10.0.1 + tsx 4.23.0; 66/66 tests, lint, format:check, typecheck, build, stdio smoke all green. 0 open PRs.
