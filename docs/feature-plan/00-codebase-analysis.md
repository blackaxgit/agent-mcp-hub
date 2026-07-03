# Codebase Analysis — Feature 3: mcp-template alignment (gap matrix)

(Prior analyses preserved in git history.) Template source: `~/Projects/mcps/mcp-template` (protocols/*.md are the binding contract; templates/typescript is a reference implementation; full extraction in the template-analyst report, summarized in 01-approach.md).

## Gap matrix — template normative requirement → agent-mcp-hub status

| # | Template requirement | Hub status |
|---|---|---|
| 1 | Auth fails closed + declared trust posture | **GAP/deviation** — default open on loopback; `MCP_TOKEN` optional. Fail-closed default would break local stdio/HTTP UX (hub is a personal local tool) |
| 2 | Cross-tenant isolation + test | N/A — single-user, no tenants |
| 3 | HTTP boundary order (origin→version→…, batch reject) | PARTIAL — origin 403 ✓, stateless ✓; version negotiation + batch handling delegated to SDK transport (verify) |
| 4/5 | No token passthrough; typed upstream creds | N/A — no upstream HTTP; CLIs hold their own auth |
| 6 | Mutating-tool discipline (hints, blast radius in description) | **GAP** — agent tools can mutate via spawned CLIs; no `readOnlyHint`/`destructiveHint`/`openWorldHint` annotations, descriptions lack blast-radius note |
| 7 | Instructions-vs-data boundary | OK by design (agent output returned as text data); document |
| 8 | SSRF/command safety | OK by design — fixed binaries, argv/stdin delivery, no shell; `cwd` client-controlled (local-tool acceptance, document) |
| 9 | Redacted logging / never-log list | OK-lean — server logs errors only to stderr; no token logging paths |
| 10 | Structured audit events for mutations | **GAP** — no audit events at all for tools that can drive code-mutating agents |
| 11 | Orientation path (instructions/capabilities) | PARTIAL — `list_agents` + `ping` exist; no `initialize.instructions` |
| 12 | Small intent-named surface | ✓ (7 tools) |
| 13 | Schemas carry contract (bounds, examples, additionalProperties) | PARTIAL — zod shapes with descriptions ✓; no `examples`, no explicit `additionalProperties:false`, no outputSchema |
| 14 | Pagination/HMAC cursors | N/A — no list tools with volume |
| 15 | Closed error taxonomy + envelope | **deviation** — SDK `isError`+text; taxonomy overkill for 7 tools (document) |
| 16 | Truthful capabilities | ✓ — tools-only declared; GET /mcp → 405 |
| 17 | Resilience: timeouts / rate limits / inflight caps | PARTIAL — per-call timeout ✓ (300s default); no rate/inflight caps (local single-user → deviation) |
| 18 | Graceful shutdown (drain on SIGTERM/SIGINT) | **GAP** — HTTP entry has no signal handling |
| 19 | /healthz + /readyz | PARTIAL — /healthz only |
| 20 | Central MCP_-prefixed env config, validated, fail-fast | **GAP** — env parsing scattered (httpServer/registry/http.ts); `PORT`/`HOST` unprefixed; only MCP_AGENTS fail-fast |
| 21 | Layer discipline | ✓ — adapters→exec→server→entries, guard-tested |
| 22 | Behavior verified through MCP surface | ✓ strong — InMemory client, real stdio e2e, HTTP client tests (53 tests) |
| 23 | Supply chain (pins, lockfile) | ✓ mostly — lockfile, SHA-pinned actions, Dependabot; Docker base is tag-pinned not digest-pinned |
| 24 | TEMPLATE-DEVIATION.md | **GAP** — the template's own mechanism for everything above; absent |
| 25 | Credential-context protocol | N/A — single-credential |
| E | Streamable HTTP stateless, 127.0.0.1, version fallback | ✓ stateless per-request, loopback bind ✓; hub ALSO ships stdio (template: HTTP-only "unless asked" → deviation to document) |

## Stack substitutions (template-sanctioned as substitutable)
raw node:http (vs Express), no Winston (stderr), vitest (vs Jest), no ESLint/Prettier configs (gap worth noting), tsconfig strict ✓.

## Touchpoints for the adoption set (proposed)
`src/config.ts` (new), `src/httpServer.ts`, `src/http.ts`, `src/index.ts`, `src/server.ts` (annotations, instructions, audit emit), `src/audit.ts` (new), `TEMPLATE-DEVIATION.md` (new), tests for each.
