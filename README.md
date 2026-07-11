# agent-mcp-hub

One MCP server that bridges multiple CLI coding agents — **Codex**, **Cursor**,
**OpenCode**, and **Claude** — into any MCP client.

> **Breaking change (v0.5.0):** The Docker image, HTTP transport, and the
> separate HTTP binary have been removed. The hub now ships stdio-only.
> A containerised server cannot see the caller's repository path or reuse the
> caller's CLI logins, so the Docker deployment broke the product contract on
> both halves.

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

Agent tools accept `prompt` (required), `model`, `cwd`, `timeoutMs` (total runtime
cap, default 1800000 = 30 min), and `idleTimeoutMs` (inactivity cap, default 300000
= 5 min). See [Long-running tasks & timeouts](#long-running-tasks--timeouts).

Known limitation: `opencode` prompts may not start with `-` (its CLI could parse
them as flags); the tool returns an actionable error instead of guessing.

### Error handling

When a wrapped CLI fails, the hub classifies the failure and returns a clean,
ANSI-free, actionable `isError` result — never a raw terminal dump — naming the
class and the exact fix:

| Class | Example remediation |
|---|---|
| `not_installed` | install the CLI (e.g. `npm i -g @openai/codex`) / fix PATH |
| `not_authenticated` | `codex login` · `cursor-agent login` · `opencode auth login` · `claude` → `/login` (or set the matching API key) |
| `not_configured` | set a model/provider in the CLI's config |
| `timed_out` | raise `timeoutMs`, or check the agent/model is responsive |
| `stream_stalled` | the agent reached the network but its stream keeps dropping (e.g. `cursor` behind a TLS-intercepting proxy) — treat that agent as unavailable; raising `timeoutMs` will not help |
| `server_busy` | retry shortly (upstream rate-limit, or the local agent-spawn queue is full) |
| `tool_failure` | generic non-zero exit — the message includes `(exit N)` and a trimmed output tail |

For example, an unauthenticated `cursor` no longer returns its ANSI "press any
key to sign in" banner — it returns `cursor is not authenticated … Fix: run
`cursor-agent login``.

### Review a change (`review_change`)

Runs a `runner` agent in a git `cwd` to make a change, captures the actual
`git diff` of what changed, then has a `reviewer` agent judge that diff. Returns
the runner's output, the diff (`--stat`), and a **PASS / WARN / FAIL** verdict
with findings.

**Inputs:** `runner`, `reviewer` (agent names), `prompt`, `cwd` (must be a git
worktree), optional `model`, `timeoutMs`.

**Key notes:**

- Cross-agent by design — e.g. `codex` writes, `claude` reviews.
- Returns the concrete diff that the plain agent tools don't expose.
- Newly-created (untracked) files are reviewed by **name only** — their contents
  are not in the diff.
- If the worktree was already dirty, the diff may include pre-existing changes
  (noted in the output).
- Complements — does not replace — client-side stop-hooks or PR-time CI review.
- The confirm gate (`MCP_CONFIRM`) applies.

```json
{
  "tool": "review_change",
  "arguments": {
    "runner": "codex",
    "reviewer": "claude",
    "prompt": "Add retry with exponential backoff to the API client",
    "cwd": "/Users/you/projects/my-app"
  }
}
```

## Prerequisites

Install and authenticate the CLIs you want to use (any subset works):

- Codex: `npm i -g @openai/codex && codex login`
- Cursor: `curl https://cursor.com/install -fsS | bash && cursor-agent login`
- OpenCode: `npm i -g opencode-ai && opencode auth login`
- Claude Code: `npm i -g @anthropic-ai/claude-code && claude` (first run logs in)

## Install

Run straight from GitHub with `npx` — no clone, no global install:

```
npx -y github:blackaxgit/agent-mcp-hub
```

This builds from source on first fetch, so under npm v12+ you must allow the
`prepare` install script. (An npm-registry release — `npx -y agent-mcp-hub` from
a prebuilt tarball, no build step — is planned but not yet published.)

### Claude Code

```bash
claude mcp add agent-hub -- npx -y github:blackaxgit/agent-mcp-hub
```

### Cursor / generic mcp.json

```json
{
  "mcpServers": {
    "agent-hub": {
      "command": "npx",
      "args": ["-y", "github:blackaxgit/agent-mcp-hub"]
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
      "args": ["-y", "github:blackaxgit/agent-mcp-hub"],
      "env": { "MCP_AGENTS": "codex,claude" }
    }
  }
}
```

### Confirm before running an agent — `MCP_CONFIRM`

Set `MCP_CONFIRM=1` (values `1`/`true`/`on`/`all`; default off) to require a
confirmation before any agent tool — and `run_all` — actually spawns a CLI. The
server sends a brief summary (agent · prompt · cwd · model) and waits: **accept**
runs the agent, **decline** runs nothing and returns a terminal cancellation.

This uses the standard MCP **elicitation** capability, so it is **client/IDE-agnostic** —
it works with any MCP client that supports form elicitation (Claude Code, Cursor,
VS Code, Zed, Windsurf, custom SDK clients, …); the gate keys on the protocol
capability, never a product name. Clients that don't support elicitation
transparently run without a prompt (no hang, no error).

```json
{
  "mcpServers": {
    "agent-hub": {
      "command": "npx",
      "args": ["-y", "github:blackaxgit/agent-mcp-hub"],
      "env": { "MCP_CONFIRM": "1" }
    }
  }
}
```

### Long-running tasks & timeouts

A complex agent task can run for many minutes. The hub bounds each run with two
independent timers so a productive long run survives while a genuinely stuck one
fails fast:

- **Idle (inactivity) timeout** — `idleTimeoutMs` (per call) / `MCP_AGENT_IDLE_TIMEOUT_MS`
  (env), default **300000 (5 min)**. The timer resets on every chunk of output the
  CLI produces, so an agent that keeps working (streaming output) never trips it. An
  agent that goes silent — e.g. `opencode` stuck on an unreachable model backend —
  is killed after the idle window with an actionable "no output — the agent may be
  hung or its model/backend is unreachable" error, instead of burning the full cap.
- **Total runtime cap** — `timeoutMs` (per call) / `MCP_AGENT_TIMEOUT_MS` (env),
  default **1800000 (30 min)**. A hard upper bound regardless of activity.

Whichever fires first kills the agent's process group. **Tradeoff:** the idle reset
assumes the CLI streams intermediate output. `codex` and `opencode` do; `claude -p`
and `cursor-agent -p` may emit only the final result, so a long **silent** task on
those can be idle-killed at 5 min — raise `idleTimeoutMs` / `MCP_AGENT_IDLE_TIMEOUT_MS`
for such tasks, or rely on the total cap.

While an agent runs, the hub emits MCP **progress notifications** to clients that
request them (`_meta.progressToken`) — live feedback during long runs. Note: on
**Claude Code (stdio)** the per-server request `timeout` in `.mcp.json` (or the
`MCP_TOOL_TIMEOUT` env var it honors) is a hard wall-clock that progress does
**not** reset (default ~28h) — raise it if you lowered it below your longest run.

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
subprocess boundary (`src/exec.ts`) → MCP stdio server (`src/server.ts`). Adding
an agent = one ~15-line adapter file + one line in `src/registry.ts`.
