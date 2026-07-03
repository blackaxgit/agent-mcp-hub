# Codex Plan Review — Feature 2 (outside engine)

Run: codex-rescue runtime, read-only, 2026-07-03. Status: ran successfully. Verdict: **NEEDS REVISION, confidence 88.** (v0.1 review preserved in git history at this path.)

## Findings (verbatim summary)
1. **MAJOR** — spec says `MCP_AGENTS=","` → all agents, but the plan's parse algorithm (split/trim/drop-empties/filter) yields an EMPTY adapter list. Fix: post-parse rule — if no names remain, return `allAdapters()`.
2. **MAJOR** — plan calls `enabledAdapters()` at top of `startHttpServer`, but `startHttpServer` is non-async: a synchronous throw bypasses `http.ts`'s `.catch()` fatal handler (stdio's `main().catch()` is safe). Fix: make `startHttpServer` async (or wrap) so validation errors reject the returned promise.
3. **MAJOR** — existing `list_agents reports availability per adapter` test gains a fourth entry `{name:"claude", available:false}` under the current mock; plan didn't call it out. Fix: update expectation.
4. **MAJOR** — concrete breakpoints: tool list → `["claude","codex","cursor","list_agents","opencode","ping","run_all"]`; registry order → `["codex","cursor","opencode","claude"]`; run_all parallelism test `started` 3→4 + claude exec assertion (`["-p","--output-format","text"]` + stdin).
5. **MINOR** — run_all mixed-labels test passes weakly without claude assertions; add `## claude (ok)` / `claude answer` checks.

Claude CLI invocation drift: none — spec/plan defer to verified research (01-approach.md). No other CI/compile/path issues found.
