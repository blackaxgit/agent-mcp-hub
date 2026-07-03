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
  - Extract one audited runner used by BOTH the per-tool handler and run_all sub-calls, wrapping the ENTIRE invocation so pre-exec throws (opencode dash-guard in `buildInvocation`) still emit:
```ts
async function runAudited(adapter: AgentAdapter, prompt: string, opts: {model?: string; cwd?: string; timeoutMs?: number}, exec: Exec, sink?: AuditSink): Promise<ExecResult> {
  const started = Date.now();
  try {
    const invocation = adapter.buildInvocation(prompt, { model: opts.model });
    const result = await exec(adapter.binary, invocation.args, { cwd: opts.cwd, timeoutMs: opts.timeoutMs, input: invocation.stdin });
    emitAudit({ ts: new Date().toISOString(), event: "tool_call", tool: adapter.name, outcome: result.exitCode === 0 ? "ok" : "error", exitCode: result.exitCode, durationMs: Date.now() - started, outputSizeClass: sizeClass(Buffer.byteLength(result.stdout, "utf8")) }, sink);
    return result;
  } catch (err) {
    emitAudit({ ts: new Date().toISOString(), event: "tool_call", tool: adapter.name, outcome: "error", exitCode: undefined, durationMs: Date.now() - started, outputSizeClass: "empty" }, sink);
    throw err;
  }
}
```
    (`outputSizeClass` = stdout bytes only, per spec decision.) Per-tool handler and run_all's allSettled map both call `runAudited`; run_all emits nothing for the aggregate (code comment).
- `tests/server.test.ts`: add M4 annotations test, M5 instructions test (`client.getInstructions()`), M6 integration audit assertions via injected sink: ok (durationMs number), non-zero exit (exitCode preserved), rejection (exitCode undefined), exitCode null preserved, dash-guard pre-exec throw emits, run_all → one event per sub-agent, no-prompt-leak negative. Existing tests untouched otherwise.

### U4 — HTTP config + TWO-PHASE drain (deps U1) — rev per gate review
- `src/httpServer.ts`:
  - Signature → `startHttpServer(config: Config): Promise<HttpHandle>` where `HttpHandle = { server: Server; beginDrain: () => void; shutdown: () => Promise<void>; isDraining: () => boolean }`.
  - Token/origins read from `config` (no per-request env); `isOriginAllowed(origin, extra: string[])` parameterized.
  - `/readyz` route: `draining ? 503 "draining" : 200 "ok"` (registered BEFORE the /mcp branch; `/healthz` untouched).
  - `beginDrain()`: sets `draining = true` only — server KEEPS accepting (this is what makes 503 observable; single-phase close would yield ECONNREFUSED/ECONNRESET, verified empirically on Node 26).
  - `shutdown()`: idempotent (memoized promise); `beginDrain(); server.closeIdleConnections(); server.close(cb)`; race close-complete vs `config.shutdownTimeoutMs` timer → on timeout `server.closeAllConnections()`; resolve when closed.
- `src/http.ts`: `const config = loadConfig(); const { beginDrain, shutdown } = await startHttpServer(config);` SIGTERM/SIGINT handler: `beginDrain(); void shutdown().then(() => process.exit(0));` with stderr log lines on begin/end.
- `tests/http.test.ts` — ALL breakpoints enumerated: `let httpServer: Server` + `beforeAll` destructure `{ server }`, `address()` via `server`, `afterAll` uses `shutdown()`; token test creates its OWN server from a token-bearing Config (shared server has none; env mutation no longer effective by design — remove the delete/restore dance); M3 deterministic drain test (readyz 200 → `beginDrain()` → readyz 503 → `await shutdown()` → connection refused → second `shutdown()` resolves).
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
