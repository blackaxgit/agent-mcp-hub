# Scope Shape — Feature 3: mcp-template alignment

## Problem
agent-mcp-hub was hand-built before adopting `~/Projects/mcps/mcp-template` as the house standard. The template's protocols prescribe a security/operability spine (fail-closed auth, audit, shutdown, config discipline, deviation register) that the hub only partially satisfies (gap matrix: 00-codebase-analysis.md).

## Chosen mode: Selective (pending user confirmation)
Full alignment would mean swapping to the skeleton stack (Express/Winston/Jest layout) and a fail-closed-by-default auth posture — high-churn, and the template itself marks the stack substitutable and provides TEMPLATE-DEVIATION.md exactly for justified divergence. The hub is a local-first personal tool; wholesale conversion buys little.

## Proposed adoption set (the spine, not the skin)
1. **TEMPLATE-DEVIATION.md** — register every deliberate divergence (open-auth-on-loopback default, stdio transport offered, no rate/inflight caps, SDK isError instead of closed error taxonomy, raw http/vitest/no-Winston substitutions) with risk + mitigation + remediation, per the template's own format.
2. **Central validated config** (`src/config.ts`): parse/validate ALL env (`MCP_TOKEN`, `MCP_ALLOWED_ORIGINS`, `MCP_AGENTS`, `MCP_PORT`/`PORT`, `MCP_HOST`/`HOST`) once, fail-fast with aggregated errors (template §operator-guide).
3. **Graceful shutdown + /readyz**: SIGTERM/SIGINT → readiness 503 → stop accepting → drain inflight with timeout → clean exit (HTTP entry).
4. **Tool annotations + orientation**: `readOnlyHint` (ping/list_agents), `destructiveHint`+`openWorldHint` + blast-radius sentence (agent tools, run_all), `initialize.instructions` server orientation string.
5. **Minimal structured audit events**: one JSON line to stderr per `tools/call` (timestamp, tool, agent, outcome, exit code, duration, output size-class — never raw payloads), matching the template's audit-event shape at local-tool scale.

## Explicitly NOT adopting (recorded as deviations instead)
Express/Winston/Jest/ESLint skeleton swap; fail-closed auth default (MCP_TOKEN stays opt-in; loopback bind is the default guard); rate limits/inflight caps; closed error-code envelope; HMAC pagination cursors; multi-tenant isolation; credential-context protocol (all N/A or disproportionate for a local single-user hub).

## 10/10 vs 5/10
10/10 = spine adopted with tests, every remaining divergence written down in TEMPLATE-DEVIATION.md with rationale — a reviewer can audit the hub against the template in minutes. 5/10 = a deviation doc alone with no behavior adopted.

## Riskiest assumption
That the user wants selective spine adoption rather than full skeleton conversion — confirmed via explicit question before the gate.
