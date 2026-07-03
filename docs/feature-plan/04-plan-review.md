# Plan Review Reconciliation — Feature 2 confidence gate

(v0.1 reconciliation preserved in git history at this path.)

Inputs: internal stress-test reviewer (NEEDS REVISION, 58/100 verbatim → ~95 with fixes) and Codex outside engine (NEEDS REVISION, 88/100; 04b-codex-plan-review.md). The two reviews independently converged on the same three majors. All findings folded into plan rev (03-implementation-plan.md T2/T3) and spec B2.

| Finding (sources) | Resolution |
|---|---|
| `list_agents` availability test breaks un-enumerated (internal F1 ≡ Codex #3) | T3 item 2: expectation gains `{name:"claude", available:false}` |
| `MCP_AGENTS=","` → plan yields ZERO adapters vs spec "all" (F2 ≡ #1) | T2 step 2: empty-after-parse → `allAdapters()`; B2 + registry test for `","` |
| HTTP fail-fast throw bypasses `.catch` (sync throw from non-async fn) (F3 ≡ #2) | T3: `startHttpServer` declared `async`; validation as first statement → rejected promise → clean fatal path, before port bind |
| Assertion breakpoints: tool list 7, registry order 4, `started` 3→4, claude exec assert (F4 ≡ #4) | T3 items 1 & 3, enumerated exactly |
| Mixed-labels run_all test weak without claude (Codex #5) | T3 item 4 |
| Silent-drop risk: filter without validation defeats G4 (F5) | T2 step 3: validate before filter |
| Hardcoded valid-names list drifts (F7) | T2 step 3: generated from `allAdapters()` |
| G5 (claude --version probe) lacks direct criterion (F6) | Accepted: structurally guaranteed by `checkAvailability(adapter.binary, ["--version"])`; indirectly covered by the availability test's 4th entry |

Both reviewers verified: registry-order consistency across all docs, claude argv matches ground-truth research, no layering/CLAUDE.md/stateless-HTTP conflicts, constraints/e2e/http/exec/smoke tests unaffected.

## Verdict
Every major and minor addressed with concrete plan text. **Confidence: 98%.** Gate PASSED — proceed to implementation. Residual 2%: real `claude` CLI runtime behavior in the Docker image (unverifiable in unit CI; exercised only by the image build + runtime use).
