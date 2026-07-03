# Implementation Plan — Feature 2: Claude adapter + agent toggles

(v0.1 plan preserved in git history at this path.)

## Tasks (ordered, with dependencies)

### T1 — Claude adapter (no deps)
- Create `src/adapters/claude.ts`: `claudeAdapter: AgentAdapter`, `buildInvocation(prompt, {model}) → { args: [<research-confirmed print-mode flags>, ...model], stdin: prompt }`.
- Create `tests/adapters/claude.test.ts`: 4 tests mirroring cursor's (no-model, model, flag-like prompt via stdin, identity). TDD order.

### T2 — Registry filtering (deps: T1)
- `src/registry.ts`:
  - Import + append `claudeAdapter` to `allAdapters()` (order: codex, cursor, opencode, claude).
  - Add `export function enabledAdapters(agentsSpec = process.env.MCP_AGENTS): AgentAdapter[]` — unset/blank → all; else split on `,`, trim, drop empties, dedupe; unknown name → `throw new Error("Unknown agent \"<name>\" in MCP_AGENTS. Valid agents: codex, cursor, opencode, claude")`; return adapters filtered to the set, registry order preserved.
- `tests/registry.test.ts`: update order assertion; add enabledAdapters tests (unset→4, subset, whitespace/dedupe, unknown-throws incl. message content).

### T3 — Wiring (deps: T2)
- `src/index.ts` and `src/httpServer.ts`: `allAdapters()` → `enabledAdapters()`. In httpServer, call ONCE at `startHttpServer` top (fail fast at startup per G4), pass the array into the per-request `buildServer` closure.
- `tests/server.test.ts`: tool-list assertion → 7 names (`["claude","codex","cursor","list_agents","opencode","ping","run_all"]`); extend run_all forwarding test with claude; add a test building the server from `enabledAdapters("codex,opencode")` asserting only those agent tools + list_agents/run_all/ping exist and list_agents reports exactly that subset.

### T4 — Packaging + docs (deps: T1–T3 for accuracy, file-disjoint)
- `Dockerfile`: install claude CLI in runtime stage (npm package per research).
- `docker-compose.yml`: add `MCP_AGENTS: ${MCP_AGENTS:-}` and `ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}`.
- `README.md`: claude tool row + prerequisites line, `MCP_AGENTS` doc (stdio + compose examples), claude auth note.

## Execution model
Two parallel subagents with disjoint files — Agent A: T1+T2+T3 (code+tests, sequential internally); Agent B: T4 (packaging/docs). Orchestrator verifies, commits per unit, gates, pushes. `git pull --rebase` before push (Dependabot merges may interleave).

## Test strategy
Unit (adapter argv/stdin, registry filter/fail-fast), integration (server tool list + filtered build + run_all forwarding via InMemoryTransport), e2e (existing stdio initialize test unaffected; CI docker job proves image builds with claude CLI).

## Rollback
Single revert of the feature commits restores v0.1 behavior; `MCP_AGENTS` unset default guarantees no behavior change for existing deployments even without revert.

## Progress log
- [ ] T1 adapter
- [ ] T2 registry
- [ ] T3 wiring
- [ ] T4 packaging/docs
- [ ] Verification + gated push
