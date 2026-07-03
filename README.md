# agent-mcp-hub

One MCP server that bridges multiple CLI coding agents — **Codex**, **Cursor**,
**OpenCode**, and **Claude** — into any MCP client.

## Tools

| Tool | Description |
|---|---|
| `codex` | Delegate a prompt to `codex exec` (prompt piped via stdin) |
| `cursor` | Delegate a prompt to `cursor-agent -p` (prompt piped via stdin) |
| `opencode` | Delegate a prompt to `opencode run` |
| `claude` | Delegate a prompt to the Claude Code CLI (prompt piped via stdin) |
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
- Claude Code: `npm i -g @anthropic-ai/claude-code && claude` (first run logs in; containers use `ANTHROPIC_API_KEY`)

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

## Configuration

**`MCP_AGENTS`** — comma-separated allowlist of the agents to expose
(`codex,cursor,opencode,claude`). Unset or empty exposes all agents. Disabled
agents get no tool and are absent from `list_agents`/`run_all`. An unknown name
fails at startup with an error listing the valid names, so typos never silently
disable an agent.

For stdio, set it in the client's `mcp.json`:

```json
{
  "mcpServers": {
    "agent-hub": {
      "command": "npx",
      "args": ["-y", "agent-mcp-hub"],
      "env": { "MCP_AGENTS": "codex,claude" }
    }
  }
}
```

For Docker Compose, put it in the `.env` file next to `docker-compose.yml`:

```bash
MCP_AGENTS=codex,claude
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
(`OPENAI_API_KEY`, `CURSOR_API_KEY`, and `ANTHROPIC_API_KEY` for the `claude`
CLI) — a `.env` file next to `docker-compose.yml` is picked up automatically —
or reuse your host CLI logins by uncommenting the read-only login-dir mounts in
`docker-compose.yml`.

**Workspace:** mount the project you want the agents to work on into `/workspace`
(the `./workspace` bind mount is preconfigured) and pass `cwd: "/workspace"` in
your tool calls.

**Security:** the `/mcp` endpoint can spawn coding agents, so treat it like a
shell. The server binds `127.0.0.1` by default (`HOST=0.0.0.0` only inside the
container) and compose publishes the port on loopback only. Browser requests
from non-loopback Origins get 403 (DNS-rebinding guard; extend via
`MCP_ALLOWED_ORIGINS`). Set `MCP_TOKEN` to require
`Authorization: Bearer <token>` on every call — mandatory before exposing the
port beyond this host (plus TLS via a reverse proxy). The cursor CLI installs
via the vendor's `curl | bash` script (no published checksums); opt out with
`docker build --build-arg INSTALL_CURSOR=false .`

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
