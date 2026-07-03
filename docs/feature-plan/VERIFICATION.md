# VERIFICATION — Feature 2: claude adapter + MCP_AGENTS toggle (2026-07-03)

(v0.1 verification preserved in git history at this path.)

Suite state: **53/53 tests (11 files), typecheck (src+tests) clean, build clean.**

## Acceptance criteria

```
B1 (claude adapter tests)          → DONE
Evidence: tests/adapters/claude.test.ts — 4 tests green; argv ["-p","--output-format",
  "text",(--model m)] + stdin, matching verified research. Codex: PASS.

B2 (registry order + enabledAdapters semantics) → DONE
Evidence: tests/registry.test.ts — order codex,cursor,opencode,claude; unset→4, ","→4,
  whitespace subset, dedupe, unknown "clade" throws with generated valid list.
  Codex: PASS (validate-before-filter confirmed at source).

B3 (server exposes/filters consistently) → DONE
Evidence: tool list = 7 sorted names; filtered-build test (codex,opencode) proves
  tools + list_agents + run_all all reflect the same subset. Codex: PASS.
  PLUS live e2e: MCP_AGENTS=codex,claude over real stdio → tools exactly
  [claude,codex,list_agents,ping,run_all]; MCP_AGENTS=clade → process exit 1.

B4 (run_all forwards to claude)    → DONE
Evidence: parallelism test started=4 + claude exec assertion; mixed-labels test
  includes "## claude (ok)". Codex: PASS.

B5 (suite/typecheck/build green locally AND in CI) → DONE locally / CI PENDING PUSH
Evidence: local 53/53 + typecheck + build clean (orchestrator-run). Codex: PARTIAL
  (its sandbox EPERM; attributed to sandbox, not repo). CI verdict follows the push.

B6 (Docker packaging)              → DONE
Evidence: Dockerfile installs @anthropic-ai/claude-code (Node 22 base OK); compose
  passes MCP_AGENTS + ANTHROPIC_API_KEY; docker compose config -q clean. Codex: PASS.
  Full image build exercised by the CI docker job after push.

B7 (README)                        → DONE
Evidence: claude tool row, prerequisites, Configuration section (stdio + compose
  examples), Docker auth note. Codex: PASS.
```

## Constraints
H1–H4: no G/H violations found by Codex; C1/C5 guard tests green; no new runtime deps; default (unset env) behavior additive-only.

## Codex
**AGREES, confidence 90** (05b-codex-verification.md).

## Notes
- CI (self-hosted) result for this feature lands with the push — recorded in the final summary, not re-edited here.
- Recursion note: hub-inside-Claude-Code can now be prevented by operators via MCP_AGENTS excluding claude (documented).

Final confidence: 97% (residual: claude CLI runtime behavior inside the Docker image, exercised only at image build/runtime).
