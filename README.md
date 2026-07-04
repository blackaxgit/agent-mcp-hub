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
- Claude Code: `npm i -g @anthropic-ai/claude-code && claude` (first run logs in; containers on macOS use `ANTHROPIC_API_KEY`)

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

### Prebuilt image (GHCR)

Publishing a GitHub Release builds and pushes the image to the GitHub Container
Registry (`.github/workflows/release.yml`). The package is **private** (it
inherits the repository's visibility), so pull it with a token that has
`read:packages`:

```bash
echo "$GITHUB_TOKEN" | docker login ghcr.io -u blackaxgit --password-stdin
docker pull ghcr.io/blackaxgit/agent-mcp-hub:latest   # or :<version>
```

The release tag must match `package.json`'s version, and the workflow
smoke-tests the image against `/healthz` before publishing, so a broken image
is never pushed. (Single-arch `linux/amd64`, built on the self-hosted runner.)

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

**Auth model — two separate things, don't conflate them:**

- **CLI credentials.** The wrapped CLIs authenticate _themselves_ from their own
  stored logins — the same model as codex-mcp-server. A fresh container is logged
  out, so `docker-compose.yml` **mounts your host login dirs read-only** to reuse
  them. Which path each CLI needs:
  - **codex / opencode / cursor** — file-based logins (`~/.codex`,
    `~/.config/opencode` + `~/.local/share/opencode`,
    `~/.local/share/cursor-agent`); the mounts carry them, no API key.
  - **claude** — on **macOS** the OAuth token lives in the **Keychain**, not
    `~/.claude`, so the mount carries config but not the login: set
    `ANTHROPIC_API_KEY` (compose has it enabled). On **Linux**, claude stores
    `~/.claude/.credentials.json` and the mount works. Note: an
    `ANTHROPIC_API_KEY` bills pay-per-token via the API, separate from a Claude
    Pro/Max subscription.
  - Caveats: mounts are read-only, so if a CLI must _refresh_ its token
    mid-session and fails, drop `:ro` for that mount or set its API key. **Comment
    out the mount for any CLI you don't use** — a missing source dir is silently
    auto-created **empty**, making that CLI act logged-out. On **native Linux**,
    host cred files owned by your uid may be unreadable to the container's uid
    1001 — then use the API-key fallbacks (macOS Docker Desktop mediates uids).
- **`MCP_TOKEN` is NOT a CLI credential** — it guards the HTTP `/mcp` endpoint
  (which can execute code) and is required whenever the server binds a network
  interface (which the container does). See Security below.

**Zero-config alternative — stdio (recommended for simple local use):** skip the
container and token entirely. `npx agent-mcp-hub` runs over stdio with no HTTP
endpoint, so there's no `MCP_TOKEN` and the CLIs use your host logins directly —
the codex-mcp-server model. See [Install](#install).

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
