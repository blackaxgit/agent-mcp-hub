# Feature Spec — agent-mcp-hub v0.1

## Requirements (functional)
1. F1 — Runs as a stdio MCP server via `npx agent-mcp-hub` (bin → `dist/index.js`), name `agent-mcp-hub`, version `0.1.0`.
2. F2 — Exposes exactly six tools: `codex`, `cursor`, `opencode`, `run_all`, `list_agents`, `ping`.
3. F3 — Each agent tool accepts `{ prompt: string (required), model?: string, cwd?: string, timeoutMs?: positive int }` and executes the corresponding CLI non-interactively as a subprocess, returning trimmed stdout as a single text content block on exit 0.
4. F4 — On non-zero exit, the tool returns `isError: true` with a message containing the agent name, exit code, and stderr (falling back to stdout).
5. F5 — On spawn failure (binary missing) the message names the binary and says it must be installed and on PATH; on timeout the message names the binary and the timeout in ms. Neither crashes the server.
6. F6 — `run_all` accepts `{ prompt, cwd?, timeoutMs? }`, runs ALL registered agents in parallel (`Promise.allSettled`), and returns one text block per agent formatted `## <name> (ok|failed)` followed by the output or error. Individual agent failure never fails the tool call.
7. F7 — `list_agents` probes each adapter with `<binary> --version` (10 s timeout) and returns JSON `[{ name, available }]` in registry order; probe errors map to `available: false`, never a thrown error.
8. F8 — `ping` returns text `pong`.
9. F9 — Default subprocess timeout 300 000 ms, overridable per call via `timeoutMs`.
10. F10 — Exact argv per agent as confirmed by research (docs/feature-plan/01-approach.md); adapters are the single place argv is built.

## Constraints (must NOT)
- C1 — No module other than `src/exec.ts` may import `node:child_process` (adapters stay pure).
- C2 — No shell interpolation: prompts are passed as a single argv element via `spawn(binary, args)` (never `shell: true`).
- C3 — No network calls from the server itself; all intelligence lives in the wrapped CLIs.
- C4 — No new runtime dependencies beyond `@modelcontextprotocol/sdk` and `zod`.
- C5 — Server must not write to stdout outside the MCP transport (stdio protocol safety); diagnostics go to stderr.

## Out of scope (v0.1)
Session resume/multi-turn, streaming/progress, config files or env-var agent config, Claude CLI adapter, npm publish, Windows CI validation.

## Acceptance criteria (testable)
- A1 — `npm test` passes; suite covers: exec success/failure/missing-binary/timeout; each adapter's argv (with and without `model`); registry order + availability true/false/throws; server ping, tool listing (exactly the six tools), agent tool success path (exec called with adapter argv and `{cwd, timeoutMs}`), non-zero-exit → `isError` with exit code + stderr, exec-rejection → `isError` with actionable message; `run_all` mixed ok/failed labeling.
- A2 — `npm run typecheck` and `npm run build` pass clean.
- A3 — Piping an MCP `initialize` JSON-RPC request into `node dist/index.js` returns a response containing `"agent-mcp-hub"`.
- A4 — `README.md` documents tools, prerequisites, and Claude Code + generic `mcp.json` install snippets.
- A5 — Conventional commits per logical unit on `main`, pushed to origin only after a clean security-gate (gitleaks/trufflehog) run.

## Edge cases
- Binary missing / not executable → F5 path (per-tool and inside `run_all`).
- Agent CLI hangs → timeout kill (SIGKILL) + rejection mapped to `isError`.
- Agent writes errors to stdout with exit ≠ 0 → stderr-empty fallback to stdout (F4).
- Prompt containing quotes/newlines/`--` prefix → safe because argv-passed (C2); prompt is appended last.
- Empty stdout on success → empty text block, not an error.
- Concurrent `run_all` with one slow agent → others' results not blocked past `Promise.allSettled` semantics (single call returns when all settle or time out).

## Open questions
None blocking — CLI flag verification delegated to research (Step 2); if research contradicts planned argv, adapters + tests change accordingly before the gate.
