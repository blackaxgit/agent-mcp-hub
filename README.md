# agent-mcp-hub

One MCP server that bridges multiple CLI coding agents — **Codex**, **Cursor**, and
**OpenCode** — into any MCP client (Claude Code, Cursor, VS Code, Windsurf, …).
Like [codex-mcp-server](https://github.com/tuannvm/codex-mcp-server), but multi-agent.

## Tools

| Tool | Description |
|---|---|
| `codex` | Delegate a prompt to `codex exec` (prompt piped via stdin) |
| `cursor` | Delegate a prompt to `cursor-agent -p` (prompt piped via stdin) |
| `opencode` | Delegate a prompt to `opencode run` |
| `run_all` | Same prompt to all agents in parallel, results side by side |
| `list_agents` | Which agent CLIs are installed and on PATH |
| `ping` | Health check |

Agent tools accept `prompt` (required), `model`, `cwd`, `timeoutMs` (default 300000).

Known limitation: `opencode` prompts may not start with `-` (its CLI could parse
them as flags); the tool returns an actionable error instead of guessing.

## Prerequisites

Install and authenticate the CLIs you want to use (any subset works):

- Codex: `npm i -g @openai/codex && codex login`
- Cursor: `curl https://cursor.com/install -fsS | bash && cursor-agent login`
- OpenCode: `npm i -g opencode-ai && opencode auth login`

## Install

### Claude Code

```bash
claude mcp add agent-hub -- npx -y agent-mcp-hub
```

### Cursor / generic mcp.json

```json
{
  "mcpServers": {
    "agent-hub": {
      "command": "npx",
      "args": ["-y", "agent-mcp-hub"]
    }
  }
}
```

## Development

```bash
npm install
npm test           # vitest
npm run typecheck  # strict TS over src + tests
npm run dev        # run from source over stdio
npm run build      # emit dist/
```

## Architecture

Pure adapters (`src/adapters/*` — prompt → `{args, stdin?}`, no I/O) → one
subprocess boundary (`src/exec.ts`) → MCP wiring (`src/server.ts`). Adding an
agent = one ~15-line adapter file + one line in `src/registry.ts`.
