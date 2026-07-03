# Scope Shape — agent-mcp-hub v0.1

## Problem & audience
Developers using MCP clients (Claude Code, Cursor, VS Code) want to delegate prompts to other installed CLI coding agents — Codex, Cursor, OpenCode — through one server instead of installing three single-purpose MCP servers (cf. tuannvm/codex-mcp-server, which covers Codex only).

## Chosen mode: Reduction
Smallest valuable slice: a stdio MCP server exposing one fire-and-forget tool per agent plus a parallel fan-out. No sessions, no streaming, no config files.

## Smallest valuable version (v0.1)
- Tools: `codex`, `cursor`, `opencode` (prompt → CLI subprocess → text result), `run_all` (parallel fan-out), `list_agents` (availability probe), `ping`.
- Pure-adapter architecture so adding an agent is one ~15-line file.
- Installable via `npx agent-mcp-hub` from any MCP client.

## Explicitly NOT building (v0.1)
- Session resume / multi-turn conversations per agent.
- Streaming or progress notifications.
- Config file / env-based agent enable-disable or default models.
- Claude CLI as a fourth agent.
- npm publish (repo push only).

## 10/10 vs 5/10
10/10 = all three agents callable with correct current CLI flags, robust failure paths (missing binary, non-zero exit, timeout), tested via in-memory MCP client. 5/10 = works only when every CLI is installed and happy.

## Riskiest assumption
That the planned CLI flags (`codex exec`, `cursor-agent -p`, `opencode run`) match the 2026 releases — being verified by a research subagent before the confidence gate.
