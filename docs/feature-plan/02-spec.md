# Feature Spec — Feature 3: mcp-template selective alignment

(Prior specs preserved in git history. Scope: user-confirmed Selective spine.)

## Requirements (functional)
1. K1 — `TEMPLATE-DEVIATION.md` at repo root in the template's format (clause / what-instead with file refs / why / risk / mitigations / remediation owner+date) covering AT LEAST: opt-in auth on loopback, stdio transport offered, no rate/inflight caps, SDK isError vs closed taxonomy, no schema examples/outputSchema, stack substitutions (raw http, stderr logging, vitest, no ESLint), tag-pinned base image, client-controlled cwd.
2. K2 — `src/config.ts`: `loadConfig(env = process.env): Config` parsing `MCP_PORT|PORT` (int 1–65535, default 3919; MCP_ wins), `MCP_HOST|HOST` (default "127.0.0.1"; MCP_ wins), `MCP_TOKEN` (optional), `MCP_ALLOWED_ORIGINS` (comma list → string[]), `MCP_SHUTDOWN_TIMEOUT_SECONDS` (positive int, default 25 → exposed as `shutdownTimeoutMs`), `MCP_AGENTS` (raw string passthrough, undefined if unset). ALL invalid fields reported together in one `ConfigError` (fail-fast, aggregated).
3. K3 — `startHttpServer(config: Config)` replaces `(port, host)`: token/origin checks read from config (no per-request `process.env` reads); origin allowlist behavior unchanged (loopback always allowed + config extras).
4. K4 — Drain lifecycle: `GET /readyz` → `200 "ok"` normally, `503 "draining"` after drain starts; `/healthz` unchanged (pure liveness). A drain controller (returned by `startHttpServer` alongside the server, or exported wiring) stops accepting new connections, waits for inflight up to `shutdownTimeoutMs`, then force-closes. `src/http.ts` wires SIGTERM/SIGINT → drain → `process.exit(0)` (or exit(1) on forced close); `startHttpServer` itself installs NO signal handlers.
5. K5 — Tool annotations: `ping` and `list_agents` get `annotations: { readOnlyHint: true }`; each agent tool and `run_all` get `annotations: { destructiveHint: true, openWorldHint: true }` and a description ending with a blast-radius sentence (agent may read/modify files under the working directory).
6. K6 — Orientation: `McpServer` constructed with `instructions` (mentions delegating to agent CLIs, `list_agents` for discovery, and `MCP_AGENTS` toggling); visible to clients via `getInstructions()`.
7. K7 — Audit: `src/audit.ts` exports `sizeClass(bytes): "empty"|"small"|"medium"|"large"` (0; <1_000; <100_000; else) and `emitAudit(event, sink?)` writing one JSON line (default sink `process.stderr`). `buildServer(adapters, exec?, auditSink?)` emits one event per agent-tool call and per `run_all` sub-call outcome: `{ts (ISO), event:"tool_call", tool, outcome:"ok"|"error", exitCode (number|null|undefined), durationMs (number), outputSizeClass}`. NEVER raw prompt/output content.
8. K8 — All existing behavior preserved: 53 current tests keep passing (modulo signature-driven test updates for K3).

## Constraints (must NOT)
- L1 — C1–C5 hold (audit writes to stderr only; C5 guard still greps clean).
- L2 — No new runtime dependencies.
- L3 — No fail-closed auth default, no rate limiting, no error-envelope change (deviations, not code).
- L4 — stdio entry (`src/index.ts`) behavior unchanged except shared `buildServer` additions (annotations/instructions/audit apply there too — additive).
- L5 — Audit events must not include prompt text, output text, cwd, or model values — only the enumerated fields.

## Out of scope
Everything in "Explicitly deferred" (01-approach.md), plus ESLint/Prettier adoption and schema examples.

## Acceptance criteria
- M1 — Config tests: defaults; MCP_PORT precedence over PORT; invalid port AND invalid shutdown timeout reported together in one ConfigError message; origins parsing; agents passthrough.
- M2 — HTTP tests updated to `startHttpServer(config)`; token test passes token via config (no env mutation); origin tests unchanged in behavior.
- M3 — Drain test: `/readyz` 200 → initiate drain → `/readyz` 503 → server closes within timeout; new connections refused after drain.
- M4 — Annotations test: `tools/list` shows `readOnlyHint` on ping/list_agents and `destructiveHint`+`openWorldHint` on all agent tools + run_all.
- M5 — Instructions test: client `getInstructions()` returns a string mentioning `list_agents` and `MCP_AGENTS`.
- M6 — Audit tests: sizeClass boundaries (0/999/1000/99_999/100_000); ok-call event shape via injected sink; error-call outcome "error"; L5 negative assertion (serialized event contains no prompt text).
- M7 — Full suite + typecheck + build green locally and in CI; C5 guard green.
- M8 — TEMPLATE-DEVIATION.md exists, covers all K1 entries, each with risk+mitigation+remediation.

## Edge cases
- `MCP_SHUTDOWN_TIMEOUT_SECONDS=0` → invalid (positive int required) → aggregated error.
- Drain with zero inflight → immediate clean close.
- Drain called twice → idempotent.
- run_all audit: one event per sub-agent (tool field = agent name, so per-agent outcomes are distinguishable) plus none for run_all itself (avoid double counting) — decided: per-sub-call events tagged with the agent's name; acceptable simplification documented in code comment.
- Audit sink throwing → must not break the tool call (wrap in try/catch, drop event).

## Open questions
None — scope user-confirmed; SDK `annotations`/`instructions` support verified in prior research.
