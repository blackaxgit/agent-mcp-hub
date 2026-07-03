# Implementation Plan — Feature 3: mcp-template selective alignment

(Prior plans preserved in git history.)

## Tasks

### U1 — Config module (no deps)
- Create `src/config.ts`:
```ts
export interface Config {
  port: number;
  host: string;
  token: string | undefined;
  allowedOrigins: string[];
  agents: string | undefined;
  shutdownTimeoutMs: number;
}
export class ConfigError extends Error {}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config
```
  Parse rules per spec K2. Collect every field error into `errors: string[]`; if non-empty throw `new ConfigError("Invalid configuration:\n- " + errors.join("\n- "))`.
- Create `tests/config.test.ts` (M1: defaults, MCP_PORT>PORT precedence, aggregated two-field error, origins list, agents passthrough, shutdown=0 invalid). TDD.

### U2 — Audit module (no deps)
- Create `src/audit.ts` per spec K7 (`sizeClass`, `AuditEvent`, `emitAudit(event, sink = line => process.stderr.write(line + "\n"))`; emitAudit wraps sink in try/catch).
- Create `tests/audit.test.ts` (M6 boundaries + shape via captured sink). TDD.

### U3 — Server: annotations, instructions, audit wiring (deps U2)
- `src/server.ts`:
  - `buildServer(adapters, exec = runCommand, auditSink?: (line: string) => void)`.
  - `new McpServer({ name, version }, { instructions: ORIENTATION })` — ORIENTATION mentions agent delegation, `list_agents`, `MCP_AGENTS`.
  - Annotations per K5; agent-tool + run_all descriptions gain the blast-radius sentence.
  - Agent tool handler + run_all sub-calls: wrap exec with timing; after settle call `emitAudit({ts: new Date().toISOString(), event:"tool_call", tool: adapter.name, outcome, exitCode, durationMs, outputSizeClass: sizeClass(Buffer.byteLength(stdout ?? ""))}, auditSink)` — errors → outcome "error", exitCode undefined on rejection. run_all emits per sub-agent, none for the aggregate (code comment).
- `tests/server.test.ts`: add M4 annotations test, M5 instructions test (`client.getInstructions()`), M6 integration audit assertions via injected sink (ok + error + no-prompt-leak negative). Existing tests untouched otherwise.

### U4 — HTTP config + drain (deps U1)
- `src/httpServer.ts`:
  - Signature → `startHttpServer(config: Config): Promise<{ server: Server; drain: () => Promise<void>; isDraining: () => boolean }>`; token/origins from config; `/readyz` route per K4; inflight tracked via `server.closeAllConnections()` at force-timeout; `drain()` idempotent: sets flag, `server.close()`, races completion vs `shutdownTimeoutMs` timer, force-closes on timeout, resolves.
  - `isOriginAllowed(origin, extra: string[])` takes the list as a param (no env read).
- `src/http.ts`: `const config = loadConfig(); const { server, drain } = await startHttpServer(config);` then `for (const sig of ["SIGTERM","SIGINT"]) process.on(sig, () => { drain().then(() => process.exit(0)); });` (stderr log lines on begin/end).
- `tests/http.test.ts`: build `Config` objects (port 0) — token test passes token via config; add M3 drain test (readyz 200 → drain() → readyz rejected-or-503 → server closed) and drain-idempotent test. NOTE: after `server.close()` new requests are refused — assert `/readyz` 503 by hitting it DURING drain only if a keep-alive connection path exists; otherwise assert `isDraining()===true` + connection refusal (plan-approved fallback assertion).
- `tests/e2e.test.ts` unaffected (stdio). `src/index.ts` unaffected.

### U5 — TEMPLATE-DEVIATION.md (independent)
- Create at repo root, template-example format, all 8 K1 entries; remediation owner "blackaxgit", dates 2026-Q4.

### U6 — README touch (after U1–U4)
- Configuration section: add `MCP_PORT`/`MCP_HOST`/`MCP_SHUTDOWN_TIMEOUT_SECONDS` and `/readyz`; one line pointing to TEMPLATE-DEVIATION.md.

## Execution model
Agent A: U1+U2 (new modules + tests, disjoint). Agent B: U5 (doc, disjoint). Then Agent C: U3+U4+U6 (touches server/http/tests — sequential after A lands). Orchestrator verifies, commits per unit, gates, pushes (pull --rebase first — Dependabot merges land concurrently).

## Test strategy
Unit: config parsing/aggregation, audit sizeClass/shape/sink-safety. Integration: annotations/instructions/audit through InMemory MCP client; drain via real HTTP server on port 0. E2E: existing stdio + CI docker build unchanged.

## Rollback
Revert the feature commits; no persisted state. `startHttpServer` signature change is internal (bin entries + tests only).

## Progress log
- [ ] U1 config
- [ ] U2 audit
- [ ] U3 server wiring
- [ ] U4 http drain
- [ ] U5 deviations doc
- [ ] U6 README
- [ ] Verification + gated push
