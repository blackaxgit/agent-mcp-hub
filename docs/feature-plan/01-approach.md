# Approach Research — agent-mcp-hub v0.1 (verified 2026-07-02)

Two research subagents verified the plan against current official docs. Verdict: **planned design is current; no argv or API changes needed; only dependency pins updated.**

## CLI invocations (verified against official docs)
| Agent | Verified argv | Notes | Source |
|---|---|---|---|
| Codex | `codex exec --skip-git-repo-check [--model m] <prompt>` | `exec` = non-interactive mode; `--skip-git-repo-check` allows running outside git repos; `-C/--cd` exists but we pass `cwd` via spawn instead. Optional future: `--json`, `--sandbox`. | developers.openai.com/codex/cli/reference |
| Cursor | `cursor-agent -p --output-format text [--model m] <prompt>` | `cursor-agent` is the canonical binary (`agent` is an alias). `text` is the default output format — kept for explicitness. Print mode grants the agent full tools. | cursor.com/docs/cli/reference/parameters |
| OpenCode | `opencode run [--model provider/model] <prompt>` | Model format is `provider/model`. npm package `opencode-ai`, binary `opencode`. | opencode.ai/docs/cli |

Availability probes: `codex --version`, `cursor-agent --version`, `opencode --version` — all top-level flags exiting 0. Gotcha confirmed: probe `codex --version`, never `codex exec --version` (matches our registry design, which probes the bare binary).

## MCP SDK (verified against @modelcontextprotocol/sdk@1.29.0 typings)
- Pin **`@modelcontextprotocol/sdk@^1.29.0`** and **`zod@^3.25`** (SDK peer range `^3.25 || ^4.0`).
- `McpServer.registerTool(name, {description, inputSchema: ZodRawShape}, handler)` is the current, non-deprecated API (`server.tool()` is deprecated). Raw zod shape — not `z.object()` — is correct.
- Import paths confirmed: `server/mcp.js`, `server/stdio.js`, `inMemory.js`, `client/index.js`.
- Handler return `{ content: [{type:"text", text}], isError? }` matches `CallToolResultSchema`. `outputSchema`/`structuredContent` optional — omitted (YAGNI for text tools).
- Test pattern `InMemoryTransport.createLinkedPair()` + `Client.callTool({name, arguments})` is the recommended in-process approach.

## Leverage / prior art
- Modeled on tuannvm/codex-mcp-server (TypeScript, stdio, subprocess-wrapping) — generalized via the adapter pattern.
- No extra runtime deps needed: `node:child_process.spawn` (argv-safe, no shell) beats adding execa for this scope.

## Corrections applied to the plan
1. `@modelcontextprotocol/sdk`: `^1.12.0` → `^1.29.0`.
2. `zod`: `^3.24.0` → `^3.25.0`.
Nothing else changed.
