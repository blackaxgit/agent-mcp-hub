# Plan Review Reconciliation — confidence gate

Inputs: internal stress-test reviewer (verdict NEEDS REVISION, 40/100 pre-fix), Codex outside engine (codex-cli 0.142.5, gpt-5.5 — verdict NEEDS REVISION, 88/100; see 04b-codex-plan-review.md), plus a targeted follow-up research pass on `--`/stdin delimiter behavior. All findings reconciled; the plan was rewritten as **rev 2** and the spec updated. Resolution map:

| Finding (source) | Severity | Resolution in rev 2 |
|---|---|---|
| Task 8 never updates Task 7's five-tool assertion → red suite, F2 unverified (both reviewers) | BLOCKER | Task 8 Step 1 now explicitly updates the assertion to the six sorted names |
| Split adapter test files kept `../src/` import depth (internal #2) | BLOCKER | Per-adapter files `tests/adapters/*.test.ts` written out with `../../src/...` imports |
| `child.stdout`/`stderr` nullable under strict TS (Codex #1, internal #5) | BLOCKER/MINOR | `child.stdout?.on(...)` optional chaining throughout exec.ts |
| `--`-prefixed prompt = CLI option-parser injection (Codex #4, internal #3) | MAJOR | Design change grounded in delimiter research: codex + cursor deliver the prompt via documented stdin paths (`-` sentinel / piped print mode); opencode (no documented stdin or `--`) gets an explicit dash-guard throw mapped to `isError` (spec F11). Injection-safety tests added per adapter + server-level guard test |
| Timeout rejects before child actually closes (Codex #3) | MAJOR | `timedOut` flag; kill then reject from the `close` handler |
| Subagents would run embedded commit steps (internal #4) | MAJOR | Plan header + every Step 5 marked "skip if running as subagent"; orchestrator commits per phase (git init already done by orchestrator with user-provided repo) |
| Task 1 typecheck with empty `src` (Codex #6) | MAJOR | Scaffold creates placeholder `src/types.ts` (`export {}`), replaced in Task 2 |
| Tests never typechecked (Codex #7, internal #7) | MAJOR | `tsconfig.test.json` (extends base, includes `src`+`tests`, noEmit); `npm run typecheck` uses it |
| Multibyte chunk corruption via per-chunk `toString()` (Codex #8) | MINOR | Buffer[] accumulation, single `Buffer.concat(...).toString("utf8")` on close |
| Timeout message shape untested at server level (Codex #9) | MINOR | Dedicated timeout-rejection server test added |
| run_all parallelism/option-forwarding unproven (Codex #10) | MINOR | Deferred-promise test: all 3 execs started before any resolves + `{cwd, timeoutMs, input}` forwarding assert |
| C1/C5 constraints unenforced (internal #6) | MINOR | `tests/constraints.test.ts` guard (greps src for child_process outside exec.ts and stdout writes) |
| F1 version / F9 default asserted nowhere (internal #8) | MINOR | Smoke grep extended to `"0.1.0"`; `DEFAULT_TIMEOUT_MS` unit assertion added |

Both reviewers independently confirmed: SDK `registerTool`/`InMemoryTransport` usage matches current SDK source; exec double-settle guarding, `allSettled` fan-out, error mapping, dependency matrix (SDK ^1.29 / zod ^3.25 / vitest ^2 / Node ≥20 / NodeNext) are sound.

## Residual risks (accepted, non-blocking)
- Real-CLI behavioral drift (e.g. cursor stdin inference nuances) can't be proven by the mocked-exec suite; mitigated by graceful `isError` paths and `list_agents` probing. Acceptance criteria are satisfiable without the CLIs installed.
- opencode dash-guard slightly restricts inputs by design (documented in README + spec F11).

## Verdict
Plan rev 2 addresses every finding from both reviews with concrete code in the plan itself. **Confidence: 98%.** Gate PASSED — proceed to implementation.
