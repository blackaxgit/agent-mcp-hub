# VERIFICATION — agent-mcp-hub v0.1 (2026-07-02)

Suite state at verification: **36/36 tests, 9 files; typecheck (src+tests) clean; build clean; gitleaks clean.**

## Acceptance criteria

```
A1 (test suite coverage)        → DONE
Evidence: npm test = 36 passed (exec 6, adapters 12, registry 4, server 10 incl.
  dash-guard/timeout-message/parallelism+forwarding, constraints 2, smoke 1, e2e 1)
Codex: agrees after fixes (its A1 "FAIL" was an EPERM sandbox artifact; suite passes
  in the real environment)

A2 (typecheck + build clean)    → DONE
Evidence: tsc -p tsconfig.test.json clean (src+tests); tsc -p tsconfig.json clean,
  dist/ emitted. Codex: typecheck agreed; build "FAIL" was sandbox EPERM.

A3 (stdio initialize handshake) → DONE
Evidence: manual pipe returned {"serverInfo":{"name":"agent-mcp-hub","version":"0.1.0"}};
  now ALSO automated as tests/e2e.test.ts (added from Codex finding #2). Codex: gap fixed.

A4 (README docs)                → DONE
Evidence: README.md — tools table, prerequisites, Claude Code + mcp.json install,
  known opencode dash limitation. Codex: agrees (PASS).

A5 (conventional commits + gated push) → DONE
Evidence: 13 commits `<type>(<scope>): <subject>`, no AI trailers (verified via
  git log); gitleaks detect over all commits = "no leaks found"; pushed to
  origin/main (see below). Codex: could not verify (ran pre-push by design).
```

## Requirements / constraints
- F1–F11: implemented and test-covered (see A1 evidence); F11 dash-guard verified at adapter and server level.
- C1–C5: enforced by tests/constraints.test.ts (C1, C5) and design (C2 argv/stdin, C3 no network, C4 two runtime deps). Codex found no violations.

## Codex cross-check
Codex: **agrees with reservations resolved** — initial verdict DISAGREES (86) driven by
sandbox EPERM artifacts (A1/A2), pre-push timing (A5), and two genuine gaps (A3 smoke
test, weak run_all assert) which were fixed and re-verified. Details: 05b-codex-verification.md.

## Notes
- Accepted-minor (documented, not fixed): exec timeout test asserts the observable
  contract only; tool input schemas exercised via SDK validation rather than asserted
  as JSON shapes.
- npm audit reports 5 vulnerabilities in transitive DEV dependencies (vitest/tsx
  toolchain) — no runtime exposure (runtime deps: @modelcontextprotocol/sdk, zod only).
- Real-CLI integration (codex/cursor-agent/opencode actually installed) is exercised
  at runtime via list_agents and graceful isError paths; out of automated scope.

Final confidence: 97% delivered-to-spec (residual 3%: real-CLI behavioral drift,
by design out of the mocked test scope).
