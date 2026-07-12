# AGENTS.md

> AI coding assistant context for this repository. `AGENTS.md` is a tool-agnostic context file read
> natively by many AI coding tools (Codex, Cursor, Copilot, Gemini CLI, Windsurf, …).
> Claude Code does not read it natively — Claude users should add `@AGENTS.md` to a `CLAUDE.md`.

**Command sources:** `package.json` scripts are authoritative — CI runs the same ones. No Makefile/Taskfile.
**Local overlay (read the nearer file when work touches those paths):**

| Path | Read when |
|---|---|
| [`.github/workflows/AGENTS.md`](.github/workflows/AGENTS.md) | Touching CI, the release pipeline, or anything that publishes. Those rules are load-bearing and break publishing silently if got wrong. |

## Overview

- **Purpose:** One MCP server that bridges multiple CLI coding agents — **Codex**, **Cursor**, **OpenCode**, and **Claude** — into any MCP client.
- **Owner:** TODO: team / maintainer
- **Type:** app — a published npm package (`agent-mcp-hub`, public on npm)
- **Stack:** Node ESM (`"type": "module"`), TypeScript, `engines.node >= 22`, npm (`package-lock.json`)
- **Runtime deps:** `@modelcontextprotocol/sdk`, `zod`. Everything else is dev-only.
- **Transport:** **stdio only.** The HTTP transport and Docker packaging were removed in v0.5.0 — a container cannot see the caller's repo path or reuse their CLI logins, which broke the product contract.
- **Distribution:** npm + the MCP Registry (`server.json`). Released automatically — see [`PUBLISHING.md`](./PUBLISHING.md).

## Commands

```bash
npm ci                 # install from package-lock
npm run dev            # run from source via tsx (no build step)
npm run build          # prebuild wipes dist/, then tsc -> dist/
npm test               # vitest run
npm run test:coverage  # vitest + coverage (97% thresholds enforced)
npm run typecheck      # tsc -p tsconfig.test.json  (covers src + tests)
npm run lint           # eslint .
npm run format         # prettier --write .   (format:check to verify only)
```

**The full gate — a change is not done until all of it passes** (this is what CI runs):

```bash
npm run build && npm run typecheck && npm run lint && npm run format:check && npm run test:coverage
```

Mutation testing (no npm script; targets `src/failure.ts` + `src/confirm.ts` per `stryker.config.json`):

```bash
npx stryker run
```

## Repository Layout

| Path | Purpose |
|---|---|
| `src/adapters/*.ts` | **Pure** adapters, one per CLI: `buildInvocation(prompt, opts) -> {args, stdin?}`. No I/O, no spawning. |
| `src/exec.ts` | **The only module that spawns processes.** Timeouts, output caps, concurrency, process-group kill. |
| `src/git.ts` | Git + file reads routed through an **injected `Exec`** — no direct spawning, no `node:fs`; stays side-effect-free. Used by the `review_change` tool. |
| `src/registry.ts` | Which agents are enabled; probes whether each CLI is actually usable. |
| `src/server.ts` | MCP tool wiring (tool schemas + handlers). |
| `src/failure.ts` | Classifies raw CLI failures into actionable errors. |
| `src/confirm.ts` | The `MCP_CONFIRM` elicitation gate. |
| `src/ansi.ts` | Strips ANSI escapes from CLI output. |
| `src/types.ts` | Shared type declarations (type-only). |
| `src/index.ts` | `#!/usr/bin/env node` bootstrap → stdio transport. |
| `tests/` | vitest; mirrors `src/`, plus `e2e.test.ts`, `smoke.test.ts`, `stdout-invariant.test.ts`. |
| `server.json` | MCP Registry manifest. Its **`version` fields are release-please-owned** — don't hand-edit those (other fields are fair game). |
| `docs/` | **gitignored.** Internal working notes only — a deliverable placed here is invisible to everyone else (that's why `PUBLISHING.md` sits at the root). |

**Layering rule:** adapters are pure (prompt in → argv/stdin out), `git.ts` is pure over an injected `Exec`, and **only `exec.ts` spawns anything**. Never spawn a process from an adapter.

## Configuration

Runtime env vars the server reads (none are secrets):

| Var | Effect |
|---|---|
| `MCP_AGENTS` | Comma-separated allowlist of agents to expose. **Case-sensitive.** Unset/empty = all. An unknown name fails fast at startup rather than silently dropping. |
| `MCP_CONFIRM` | One of `1` / `true` / `on` / `all` → ask for confirmation (via MCP **form elicitation**) before spawning any agent. **Not a hard gate:** a client that doesn't advertise form-elicitation capability **runs ungated**, warning once. Keyed on the protocol capability, never a product name. |
| `MCP_AGENT_TIMEOUT_MS` | Total runtime cap per agent run (default `1800000`). |
| `MCP_AGENT_IDLE_TIMEOUT_MS` | Inactivity cap; resets on every chunk of output (default `300000`). |
| `MCP_MAX_CONCURRENT_AGENTS` / `MCP_MAX_QUEUE` | Override the spawn-concurrency semaphore and its queue bound (both have built-in defaults). |

## Testing

- **vitest.** Coverage thresholds are **97%** (statements/branches/functions/lines) and enforced; `src/index.ts` and `src/types.ts` are the only exclusions, each justified in `vitest.config.ts`.
- Every behavior change needs a **happy path AND at least one failure path**. Test the contract, not the implementation.

Run one file, or one test by name:

```bash
npx vitest run tests/adapters/cursor.test.ts        # one file
npx vitest run -t "always passes --force"           # one test
```

`tests/stdout-invariant.test.ts` **rebuilds `dist/` in `beforeAll`** before spawning the server — deliberately, so a stale build cannot mask a stdout regression. Don't optimize that away.

## Conventions

Only the non-obvious ones (formatting, unused vars, floating promises are enforced by prettier/eslint — not restated here):

- **How the prompt reaches each CLI differs per adapter — check before changing one:**
  - `codex`, `cursor`, `claude` → prompt piped via **stdin**, never a positional arg (a prompt starting with `-` would be parsed as a flag). They return `{args, stdin}`.
  - `opencode` → prompt IS a **positional** arg (`args.push(prompt)`, no stdin) — its CLI documents neither stdin input nor a `--` delimiter. **Because** it is positional, the adapter *rejects* prompts starting with `-` with an actionable error rather than risk flag-injection.
- **Fail fast with actionable errors.** `src/failure.ts` classifies CLI failures into nine `FailureCode`s: `not_installed`, `invalid_cwd`, `not_authenticated`, `not_configured`, `timed_out`, `output_limit`, `stream_stalled`, `server_busy`, `tool_failure`. **Most carry a concrete `Fix:`; two do not** — `stream_stalled` (the agent is simply unavailable; raising the timeout won't help) and the fallback `tool_failure` (returns the exit code plus a trimmed, ANSI-stripped output tail). Never surface a raw terminal dump.
- **Agent CLI flags are version-sensitive and load-bearing.** Confirm a flag exists in the installed CLI (`<cli> --help`) before adding it — see the cursor `--trust` incident in Gotchas.

## Git & Workflow

- **Conventional Commits.** The type drives the released version, so it is functional, not cosmetic (release-please's conventional-commits default for `release-type: node`):
  - `fix:` → patch · `perf:` → **patch** · `feat:` → minor · `feat!:` / `BREAKING CHANGE:` → major
  - `chore:` `docs:` `ci:` `test:` `refactor:` → **no release**
- No AI-signature / "Generated by" / `Co-Authored-By` trailers in commit messages.
- No `CODEOWNERS` and no `CONTRIBUTING.md` exist. TODO: document review requirements, if any.

### Releasing

Automated via **release-please** + **npm OIDC trusted publishing**:

1. Land Conventional Commits on `main`.
2. release-please opens/updates a **Release PR** — it bumps `package.json` **and** `server.json` and writes `CHANGELOG.md`.
3. **Merge the Release PR** → it tags `vX.Y.Z`, creates the GitHub Release, and in the same run publishes to **npm** and the **MCP Registry**.

*Merge a Release PR → it's on npm.* No tokens, no manual step.

**First-publish knowledge** (already done here; needed again only for a new package name). A brand-new npm name **cannot** be created via OIDC, so the first release is manual, in this order:
`npm login` → `npm publish` → `git tag vX.Y.Z` + push the tag → create the GitHub Release → attach the npm **Trusted Publisher** → re-anchor `bootstrap-sha` in `release-please-config.json` to that tag's commit.
Full runbook: [`PUBLISHING.md`](./PUBLISHING.md). ⚠️ **`PUBLISHING.md` step 4 is currently STALE** — see the workflows overlay before following it.

Deep pipeline rules live in [`.github/workflows/AGENTS.md`](.github/workflows/AGENTS.md).

## Consuming this MCP (install / update)

**Recommended — global install** (instant startup, reliable connection):

```bash
npm i -g agent-mcp-hub@<version>          # e.g. 0.5.1
claude mcp add agent-hub -- agent-mcp-hub
# mcp.json:  "command": "agent-mcp-hub"
```

**Zero-install alternative — npx.** Works, but npx re-resolves the package on every launch, so first start is slower and can trip a client's connection-probe timeout (the server is fine — retry):

```bash
claude mcp add agent-hub -- npx -y agent-mcp-hub@<version>
# mcp.json:  "command": "npx", "args": ["-y", "agent-mcp-hub@<version>"]
```

**Upgrading:**
- Global: `npm i -g agent-mcp-hub@<newer>`, then restart the client.
- npx pinned: bump the version in `args`. Reproducible — preferred for shared/checked-in configs.
- Floating `@latest`: **npx caches by version and can serve a stale copy.** Force a refresh with `npx clear-npx-cache` (or `npx --prefer-online agent-mcp-hub`), then restart the client.

**Pre-release / unreleased code** (builds from source): `npx -y github:blackaxgit/agent-mcp-hub#<tag-or-sha>`.

## Gotchas

Each of these breaks the build, the protocol, or a release if ignored.

- **stdout is the JSON-RPC channel. Never write to it.** A single `console.log` — yours *or* a dependency's — corrupts the stream and kills every client connection. All diagnostics go to **stderr** (`console.error` / `console.warn`). An eslint `no-console` rule and `tests/stdout-invariant.test.ts` both enforce it: **if you hit that lint error, fix the code — do not disable the rule.**

- **The `cursor` adapter must pass `--force`, never `--trust`.** `cursor-agent` has no `--trust` flag: passing it exits 1 with `unknown option '--trust'`, which shipped the `cursor` tool completely broken in v0.5.0 (fixed in 0.5.1). `-f/--force` is what suppresses the interactive permission prompt — without some such flag, a run in an unfamiliar cwd hangs until the idle timeout. Tests assert `--force` present **and** `--trust` absent.

- **`prebuild: rm -rf dist` is load-bearing — do not remove it.** `tsc` does not clean `dist/`, so files whose sources were deleted linger and get **published**. v0.5.0 shipped dead `dist/http.js` + `dist/httpServer.js` from the removed HTTP transport for exactly this reason.

- **`prepublishOnly` re-runs a *subset* of the gate at publish time** — `build && typecheck && test:coverage` (no lint/format). CI covers the full gate on push-to-`main`/PR, so a red test normally stops you earlier; but a coverage dip that slips through fails the **release itself**.

- **The MCP Registry validates that `package.json`'s `mcpName` equals `server.json`'s `name`.** That check is server-side (in `mcp-publisher`), so nothing in-repo catches a mismatch — keep them in sync by hand.

- **`docs/` is gitignored.** Anything written there is local-only and invisible to everyone else. Deliverable docs go at the repo root.

- **Live agent tools depend on the operator's CLI logins and models.** `list_agents` reports `installed` and `usable` separately — a CLI can be on PATH yet unauthenticated, or pointed at an unreachable model. A failing `codex`/`cursor`/`opencode`/`claude` tool is often environment, not code: check `list_agents` first.

## Permission Boundaries for AI Agents

**Always allowed**
- Read any file; `git status` / `git diff` / `git log`
- `npm run lint`, `npm run format`, `npm run typecheck`, `npm run build`
- `npm test`, `npm run test:coverage`, `npx vitest run <file>`

**Ask first**
- Any edit under `.github/workflows/` (read the overlay — a mistake there breaks publishing silently)
- Bumping dependencies, or changing `package.json` `scripts` / `files` / `bin` / `publishConfig`
- Editing `release-please-config.json`, `.release-please-manifest.json`, or `server.json`
- Lowering or excluding anything from the 97% coverage thresholds

**Never without explicit human approval**
- `npm publish` — publishing is irreversible; CI does this, you should not
- Merging a Release PR (it publishes to npm on merge)
- `git push`, force-push, deleting branches, or committing directly to `main`
- Rotating/creating npm tokens, or changing the npm Trusted Publisher config
- Disabling the `no-console` eslint rule or deleting `tests/stdout-invariant.test.ts`
