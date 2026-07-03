# Implementation Plan — Feature 2: Claude adapter + agent toggles

(v0.1 plan preserved in git history at this path.)

## Tasks (ordered, with dependencies)

### T1 — Claude adapter (no deps)
- Create `src/adapters/claude.ts`: `claudeAdapter: AgentAdapter`, `buildInvocation(prompt, {model}) → { args: [<research-confirmed print-mode flags>, ...model], stdin: prompt }`.
- Create `tests/adapters/claude.test.ts`: 4 tests mirroring cursor's (no-model, model, flag-like prompt via stdin, identity). TDD order.

### T2 — Registry filtering (deps: T1) — rev per gate reviews
- `src/registry.ts`:
  - Import + append `claudeAdapter` to `allAdapters()` (order: codex, cursor, opencode, claude).
  - Add `export function enabledAdapters(agentsSpec = process.env.MCP_AGENTS): AgentAdapter[]`:
    1. Parse: split on `,`, trim, drop empties, dedupe.
    2. **If the parsed list is empty (covers unset, `""`, `","`, `" , "`) → return `allAdapters()`** (never an empty server).
    3. **Validate BEFORE filtering:** for each requested name not in the known set, throw `new Error(\`Unknown agent "<name>" in MCP_AGENTS. Valid agents: ${allAdapters().map(a => a.name).join(", ")}\`)` — the valid list is GENERATED, not hardcoded; plain filtering would silently drop typos.
    4. Return `allAdapters().filter(a => set.has(a.name))` (registry order preserved, dedupe free).
- `tests/registry.test.ts`: update order assertion to 4 names; enabledAdapters tests: unset→4, `","`→4, subset `"codex, claude"` (whitespace) → exact order-preserving pair, duplicates deduped, unknown name throws with the name AND the valid list in the message.

### T3 — Wiring (deps: T2) — rev per gate reviews
- `src/index.ts`: `allAdapters()` → `enabledAdapters()` (throw lands inside async `main()` → existing fatal handler — already safe).
- `src/httpServer.ts`: **declare `startHttpServer` `async`** and call `const adapters = enabledAdapters()` as its first statement — a validation throw becomes a rejected promise → `http.ts`'s `.catch()` fatal path (a sync throw from a non-async function would bypass it). Pass `adapters` into the per-request `buildServer` closure. Fails before binding the port.
- `tests/server.test.ts` — EVERY changed assertion enumerated:
  1. Tool list → `["claude","codex","cursor","list_agents","opencode","ping","run_all"]`.
  2. `list_agents reports availability per adapter` → 4th element `{name:"claude", available:false}` (mock throws for non-codex).
  3. run_all parallelism test: `started` 3→4; add `expect(exec).toHaveBeenCalledWith("claude", ["-p","--output-format","text"], {cwd:"/tmp", timeoutMs:1234, input:"p"})`.
  4. run_all mixed-labels test: add `## claude (ok)` and `claude answer` assertions (claude mock hits the default ok branch).
  5. NEW filtered-build test: `buildServer(enabledAdapters("codex,opencode"), exec)` → listTools exactly `["codex","list_agents","opencode","ping","run_all"]`; `list_agents` returns only those two; `run_all` fans out to exactly two exec calls.
- Confirmed UNAFFECTED (reviewer-verified): constraints, e2e, http, exec, smoke tests.

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
