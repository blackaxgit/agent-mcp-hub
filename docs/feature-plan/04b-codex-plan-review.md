# Codex Plan Review (outside engine)

Run: codex-cli 0.142.5, model gpt-5.5, sandbox read-only, 2026-07-02. Status: ran successfully; findings verbatim below. Verdict: **NEEDS REVISION**, confidence 88. Codex independently confirmed the plan's `registerTool` and `InMemoryTransport.createLinkedPair` usage matches current SDK source.

## Findings

1. **BLOCKER** — plan exec.ts: `child.stdout`/`child.stderr` are nullable in Node typings; fails `strict: true` typecheck. Fix: `child.stdout?.on(...)` / `child.stderr?.on(...)` or explicit null check.
2. **BLOCKER** — plan Task 7 server.test.ts expects five tools, but spec F2 requires six including `run_all`; after Task 8 the suite fails. Fix: Task 8 must update the expectation to `["codex","cursor","list_agents","opencode","ping","run_all"]`.
3. **MAJOR** — exec.ts timeout rejects immediately after `SIGKILL`, before the child actually closes; leaks cleanup beyond promise lifecycle, flaky timeout tests. Fix: set `timedOut` flag, kill, reject from the `close` handler.
4. **MAJOR** — "argv-passed so `--`-prefixed prompts are safe" is wrong for CLI option-parser injection (prompt `--help` may parse as a flag). Fix: use `--` end-of-options delimiter where supported; otherwise document/validate the limitation; add `--x`-prompt tests.
5. **MAJOR** — 03-implementation-plan.md splits adapter tests into `tests/adapters/*.test.ts` but the authoritative plan code uses one shared `tests/adapters.test.ts` appended across tasks — breaks disjoint parallel ownership. Fix: make the split real (separate test files) in the executed tasks.
6. **MAJOR** — Task 1 runs `tsc --noEmit` with `include: ["src"]` but no src files exist yet; tsc errors on no inputs. Fix: create placeholder `src/types.ts` in scaffold or defer typecheck.
7. **MAJOR** — tests are never typechecked (`include: ["src"]` only); vitest transpilation can pass strict-violating test code. Fix: add `tsconfig.test.json` covering `src/**` + `tests/**` and use it in `npm run typecheck`.
8. **MINOR** — per-chunk `Buffer.toString()` can corrupt multibyte UTF-8 split across chunks. Fix: accumulate buffers, decode once on close.
9. **MINOR** — server rejection tests cover missing-binary but not the timeout message shape required by F5. Fix: add timeout-message test.
10. **MINOR** — run_all test can't distinguish parallel from sequential execution, and doesn't assert option forwarding. Fix: deferred-promise parallelism assertion + `{cwd,timeoutMs}` forwarding check.

## Process note
The Codex subagent reported that a local `PreToolUse:Bash` hook repeatedly injected "Delegate via Agent tool" instructions contradicting its role; it correctly ignored them. Possible hook misconfiguration worth reviewing (hook applies orchestrator rules to specialist subagents).
