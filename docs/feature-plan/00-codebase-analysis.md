# Codebase Analysis — agent-mcp-hub

## Current state
Greenfield. The repository (`git@github.com:blackaxgit/agent-mcp-hub.git`, empty remote, fresh local `main`) contains only documentation:

- `docs/superpowers/plans/2026-07-02-agent-mcp-hub.md` — approved 9-task TDD implementation plan (source of truth for design).
- `docs/feature-plan/*` — this pipeline's artifacts.

No source code, no package.json, no CI, no existing conventions to inherit. No project CLAUDE.md; the user's global CLAUDE.md applies (strict layering, subagents never commit, conventional commits without AI trailers, mandatory pre-push security gate).

## Target stack (from the approved plan)
- TypeScript strict ESM (`NodeNext`), Node ≥20.
- `@modelcontextprotocol/sdk` (McpServer + StdioServerTransport), `zod` input schemas.
- `vitest` tests; in-memory MCP client/server pair for integration tests.
- Layering: pure adapters (`src/adapters/*`) → single subprocess boundary (`src/exec.ts`) → MCP wiring (`src/server.ts`) → bin entry (`src/index.ts`).

## Feature touchpoints
Everything is created new; nothing breaks, no migrations. External touchpoints are the three CLI binaries on PATH (`codex`, `cursor-agent`, `opencode`) — integration with them is subprocess-only, validated at runtime by `list_agents` and per-call error handling.

## Build/test/deploy
`npm run build` (tsc → dist), `npm test` (vitest), bin `agent-mcp-hub`. Deploy = git push to origin (npm publish out of scope).
