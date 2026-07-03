# Dependabot PR Merge — plan & verification record (2026-07-03)

Operational task (right-sized /my-feature): merge PRs #3 (@types/node 20→26), #4 (zod 3.25→4.4), #5 (typescript 5.9→6.0) with proof the MCP server stays intact. Standard feature-plan doc paths are owned by in-flight Feature 3, so this task records here. #1 (node 26 image) was closed by policy; #2 (vitest 4) merged earlier after green CI.

## Merge criteria (the gate — empirical, not document-review)
A PR merges only if, in an isolated worktree merged against CURRENT main: `npm ci && npm test && npm run typecheck && npm run build` all pass. Additionally the COMBINED state (all three merged, lockfile regenerated) must pass the same suite PLUS the stdio initialize smoke — that combined state is what main becomes, so it is the binding check. Codex outside review intentionally skipped: the certainty source for dependency bumps is the test suite, not plan review (deviation from the /my-feature ceremony, stated openly).

## Known context
- typescript 6: main already carries the compat fix (`"types": ["node"]`).
- zod 4: SDK peer range `^3.25 || ^4.0`.
- @types/node 26: types-only; runtime engines stay `>=20`.
- Earlier docker-job failures on these PRs were infrastructure (disk-full, orphaned runner listener) — both root-caused and fixed; not code signals.

## Execution
1. Four parallel worktree verifications: per-PR (merge vs main) + combined (lockfile regen via `npm install --package-lock-only`).
2. Merge order on green: #4 → #3 → #5 (squash, delete branch), `@dependabot rebase` between merges as needed for lockfile conflicts.
3. Post-merge: pull main, full local suite re-run, one CI run on main green.

## Results (2026-07-03)
- Four isolated-worktree verifications, ALL SAFE: #3, #4, #5 each clean vs main (53/53 tests, typecheck, build) and the combined state (zero merge conflicts, lockfile regen was a no-op diff, 53/53, stdio handshake OK).
- Notable evidence: SDK 1.29 peer range satisfied by zod 4.4.3 (single deduped version, 0 vulns); TS 6.0.3 compiles both tsconfigs with the existing `types:["node"]` fix; @types/node 26 typechecks against our API usage.
- Merged #4 → #3 → #5 (squash, branches deleted). Post-merge main re-verified locally: 53/53, typecheck, build, stdio initialize smoke — all green.
- Residual risk accepted: zod 3→4 cosmetic JSON-schema differences for tool inputs (no snapshot test; behavior tests cover the contract).
- Repo state: 0 open PRs; #1 closed by LTS policy with a Dependabot major-version ignore.
