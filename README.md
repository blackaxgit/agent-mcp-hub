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

## Run with Docker

Build and start the server (HTTP transport) with Docker Compose:

```bash
docker compose up -d --build
```

The server listens on `http://localhost:3919/mcp`; health check is at
`http://localhost:3919/healthz`.

Point an MCP client at it via `mcp.json`:

```json
{
  "mcpServers": {
    "agent-hub": {
      "url": "http://localhost:3919/mcp"
    }
  }
}
```

Or with Claude Code:

```bash
claude mcp add --transport http agent-hub http://localhost:3919/mcp
```

**Auth:** the wrapped CLIs need credentials. Either pass API keys as env vars
(`OPENAI_API_KEY`, `CURSOR_API_KEY`) — a `.env` file next to `docker-compose.yml`
is picked up automatically — or reuse your host CLI logins by uncommenting the
read-only login-dir mounts in `docker-compose.yml`.

**Workspace:** mount the project you want the agents to work on into `/workspace`
(the `./workspace` bind mount is preconfigured) and pass `cwd: "/workspace"` in
your tool calls.

Prefer stdio? `npx agent-mcp-hub` still works without Docker (see
[Install](#install)).

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
