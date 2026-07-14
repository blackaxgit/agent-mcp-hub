# agent-mcp-hub

One MCP server that bridges multiple CLI coding agents — **Codex**, **Cursor**,
**OpenCode**, and **Claude** — into any MCP client.

> **stdio only — by design.** The hub ships no Docker image and no HTTP
> transport (both were removed during the 0.5.x line). A containerised or remote
> server cannot see the caller's repository path and cannot reuse the caller's
> CLI logins — it would break the product contract on both halves. The hub runs
> as a child process of your MCP client, on your machine, as you.

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
- Newly-created (untracked) files are surfaced to the reviewer **with their
  contents** (bounded: 64 KiB per file, 50 files; excess is truncated and
  flagged). `git diff` alone would omit them entirely.
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

**Recommended — global install (fast, reliable startup):** install the pinned
version once, then point your client at the `agent-mcp-hub` binary. Startup is
instant and the client connects reliably.

```bash
npm i -g agent-mcp-hub@0.5.0
```

### Claude Code

```bash
claude mcp add agent-hub -- agent-mcp-hub
```

### Cursor / generic mcp.json

```json
{
  "mcpServers": {
    "agent-hub": {
      "command": "agent-mcp-hub"
    }
  }
}
```

### Zero-install alternative (npx)

No global install, but npx re-resolves the package on every launch, so first
start is slower and can occasionally trip a client's connection-probe timeout
(the server itself is fine — just retry). Prefer the global install for a
persistent setup.

```bash
claude mcp add agent-hub -- npx -y agent-mcp-hub@0.5.0
# mcp.json:  "command": "npx", "args": ["-y", "agent-mcp-hub@0.5.0"]
```

> **Pre-release / fallback:** To test an unreleased commit, run directly from
> GitHub: `npx -y github:blackaxgit/agent-mcp-hub#<tag-or-sha>`. This builds
> from source on first fetch, so under npm v12+ you must allow the `prepare`
> script.

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
      "args": ["-y", "agent-mcp-hub@0.5.0"],
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
      "args": ["-y", "agent-mcp-hub@0.5.0"],
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

## Upgrading

**Global install:** install the new version — the pinned `agent-mcp-hub` command
in your MCP config picks it up on the next client start:

```bash
npm i -g agent-mcp-hub@0.6.0
```

**npx (pinned):** bump the pinned version in your MCP config — e.g. change
`agent-mcp-hub@0.5.0` to `agent-mcp-hub@0.6.0` everywhere.

**Always-latest (not recommended for shared configs):** use `agent-mcp-hub@latest`
instead of a pinned version. Note that `npx` caches by version — it may serve a
stale copy. Force a fresh fetch with `npx --prefer-online agent-mcp-hub` or
`npx clear-npx-cache`.

Pinning is reproducible and recommended for team-wide or checked-in
`mcp.json` files.

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

## License

[Mozilla Public License 2.0](./LICENSE) (MPL-2.0).

Versions **before 0.5.2 were released under the MIT license**; that grant stands
for those versions. MPL-2.0 applies from 0.5.2 onward.
