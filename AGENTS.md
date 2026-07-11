# AGENTS.md

Guidance for AI coding agents (Claude Code, Cursor, Codex, OpenCode, …) and human
contributors working on **agent-mcp-hub** — a stdio MCP server that bridges the
Codex, Cursor, OpenCode, and Claude CLI agents into any MCP client.

## Project shape

- **Runtime:** Node ESM (`"type": "module"`), TypeScript, `engines.node >= 22`.
- **Entry:** `src/index.ts` → `bin: agent-mcp-hub` → `dist/index.js`. Transport is
  **stdio only** (HTTP transport and Docker packaging were removed in v0.5.0).
- **Layout:** pure adapters in `src/adapters/*` (prompt → `{args, stdin?}`, no I/O);
  side effects (spawning CLIs, git, fs) isolated in `src/exec.ts`, `src/git.ts`;
  wiring in `src/registry.ts` and `src/server.ts`. Keep this layering — adapters
  stay pure, I/O stays at the boundary.
- **Deps:** runtime = `@modelcontextprotocol/sdk`, `zod`. Everything else is dev.

## Develop

```bash
npm ci                 # install (uses package-lock)
npm run dev            # run from source via tsx (no build)
npm run build          # prebuild cleans dist/, then tsc -> dist/
npm test               # vitest run
npm run test:coverage  # vitest + coverage (thresholds enforced)
npm run typecheck      # tsc -p tsconfig.test.json
npm run lint           # eslint
npm run format         # prettier --write   (format:check to verify)
```

**Full gate before proposing a change is done** (all must pass):

```bash
npm run build && npm run typecheck && npm run lint && npm run format:check && npm run test:coverage
```

### Hard rules (enforced)

- **stdout is the JSON-RPC channel — never write to it.** No `console.log` / no
  `process.stdout.write` in `src/`. Diagnostics go to **stderr** (`console.error`
  / `console.warn`). This is enforced by an ESLint `no-console` rule (allowing only
  `error`/`warn`) **and** `tests/stdout-invariant.test.ts`, which spawns the built
  server and asserts every stdout line is valid JSON-RPC. A stray `console.log`
  fails both lint and that test.
- **Behavior tests, happy + one failure path**, for every behavior change. Test the
  contract, not the implementation.
- **Fail fast with actionable errors** (what failed, why, the fix). See
  `src/failure.ts` for the error-classification pattern.
- **Conventional Commits** (`feat`, `fix`, `docs`, `chore`, `refactor`, `test`,
  `ci`, `perf`) — the commit type drives the released version (see below).
- **Pin GitHub Actions by commit SHA** (with a `# vX` comment); keep self-hosted
  runner labels intact.
- No AI-signature / `Co-Authored-By` trailers in commit messages.

## Release a new version (maintainer)

Releases are automated with **release-please** + **npm OIDC trusted publishing**.
Once the one-time bootstrap is done (see below), the flow is:

1. Land Conventional Commits on `main`. The type sets the bump:
   - `fix:` → patch (0.5.0 → 0.5.1)
   - `feat:` → minor (→ 0.6.0)
   - `feat!:` / `BREAKING CHANGE:` → major (→ 1.0.0)
   - `chore:` / `docs:` / `ci:` / `test:` / `refactor:` → **no release**
2. `release-please` opens/updates a **Release PR** — it bumps `package.json` and
   `server.json` (via a `$..version` JSON updater) and writes `CHANGELOG.md`.
3. **Merge the Release PR.** It tags `vX.Y.Z`, creates the GitHub Release, and — in
   the same workflow run — invokes `.github/workflows/publish.yml`, which does
   `npm publish` (OIDC, no token, provenance) on `ubuntu-latest` and publishes the
   MCP Registry manifest.

That's the whole loop: **merge a Release PR → it's on npm.**

### First-time bootstrap (once per package name)

A brand-new npm name cannot be created via OIDC, so the first `0.x.0` is published
by hand. Full steps are in **[`PUBLISHING.md`](./PUBLISHING.md)** — in short:
`npm login` → `npm publish` → `git tag v0.5.0` + GitHub Release → set the trusted
publisher on npmjs.com → re-anchor `bootstrap-sha`. After that, never manual again.

Workflows involved:
- `.github/workflows/release-please.yml` — opens Release PRs; calls `publish.yml`
  on merge (gated on `release_created`).
- `.github/workflows/publish.yml` — reusable; npm OIDC publish (ubuntu-latest) +
  MCP Registry publish (self-hosted OK). Also runnable manually.
- `.github/workflows/release.yml` — manual `workflow_dispatch` escape hatch.
- `.github/workflows/ci.yml` — gitleaks secret scan + build/test/lint/format.

## Install & update the MCP (consumer)

**Recommended — global install** (instant startup, reliable connection):

```bash
npm i -g agent-mcp-hub@0.5.0
claude mcp add agent-hub -- agent-mcp-hub
# or in mcp.json:  "command": "agent-mcp-hub"
```

**Zero-install alternative — npx** (no global install, but re-resolves each
launch, so first start is slower and can trip a client's connection-probe
timeout — the server is fine, just retry):

```bash
claude mcp add agent-hub -- npx -y agent-mcp-hub@0.5.0
# or in mcp.json:  "command": "npx", "args": ["-y", "agent-mcp-hub@0.5.0"]
```

**Update to a new version:**
- Global: `npm i -g agent-mcp-hub@0.6.0` — the `agent-mcp-hub` command picks it up
  on next client start.
- npx pinned: bump the number in `args`, e.g. `agent-mcp-hub@0.6.0`. Reproducible.
- Floating (`agent-mcp-hub@latest`): updates on next start, but npx caches by
  version and can serve a stale copy — force a refresh with `npx clear-npx-cache`
  (or `npx --prefer-online agent-mcp-hub`), then restart the client.

**Pre-release / unreleased code** (fallback, builds from source):
`npx -y github:blackaxgit/agent-mcp-hub#<tag-or-sha>`.

See the README **Install** / **Upgrading** sections for the same, consumer-facing.
