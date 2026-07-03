# 06 — Architecture (structural findings)

7 findings, raw (pre-filter). Verification outcomes are cross-referenced in `07-filtered.md`.

## A1 — Timeout kill orphans the agent's process tree in a long-lived server
- **Severity:** High
- **file:line:** `src/exec.ts:31`
- **Problem:** On timeout, `child.kill("SIGKILL")` signals only the directly spawned CLI process. All four wrapped agents (codex, claude, cursor-agent, opencode) spawn their own subprocess trees (node workers, git, shells). In the long-lived HTTP deployment (docker-compose, `restart: unless-stopped`) every timed-out call leaks a still-running agent subtree that keeps consuming CPU/memory/API credits, so the single hub process degrades over time — a self-inflicted single point of failure.
- **Fix:** In `runCommand`, spawn with `detached: true` so the child gets its own process group, and in the timeout handler kill the whole group: `if (child.pid) process.kill(-child.pid, "SIGKILL")` (fall back to `child.kill("SIGKILL")` on error). Add a test asserting a grandchild process is dead after timeout.
- **Note:** Same defect as Green's G2; merged as P1 item 1 in the Purple report.

## A2 — No concurrency cap on agent spawns — HTTP endpoint is an unbounded fork bomb
- **Severity:** Medium
- **file:line:** `src/httpServer.ts:32`
- **Problem:** Each POST `/mcp` is handled statelessly and each tool call spawns a child process (run_all spawns one per enabled adapter) with a 300s default timeout and no queue, semaphore, or in-flight limit anywhere in server.ts or exec.ts. A burst of N requests yields up to N*4 concurrent heavyweight agent CLIs, exhausting PIDs/memory — the primary scalability bottleneck, reachable without auth when `MCP_TOKEN` is unset.
- **Fix:** Add a small in-process semaphore in exec.ts (`MAX_CONCURRENT_AGENTS`, default ~4, env-overridable) that queues or fast-fails (`isError` with "server busy, retry") when the limit is reached. Wire it inside `runCommand` so both stdio and HTTP transports inherit it.

## A3 — run_all duplicates per-agent tool execution logic and diverges from its API contract
- **Severity:** Medium
- **file:line:** `src/server.ts:86`
- **Problem:** The per-agent handler (lines 46-72) and run_all (lines 86-108) independently implement buildInvocation → exec → exit-code/error formatting, and have already diverged: individual tools accept a `model` parameter, run_all hard-codes `buildInvocation(prompt, {})` and offers no model control, and its error text format differs (`## name (failed)` vs `name failed (exit ...)`). Every future execution concern (concurrency cap, output truncation, structured errors) must now be fixed in two places — the repo's main tech-debt hotspot.
- **Fix:** Extract a single `runAdapter(adapter, exec, {prompt, model, cwd, timeoutMs}): Promise<{ok: boolean; text: string}>` helper; have both handlers call it. Add an optional `model` (or per-agent `models` map) field to run_all's inputSchema and pass it through.

## A4 — Unbounded child stdout/stderr buffering
- **Severity:** Medium
- **file:line:** `src/exec.ts:41`
- **Problem:** `runCommand` accumulates all stdout/stderr chunks in memory with no size limit, then returns the full string as one MCP text block. A verbose or misbehaving agent (e.g. one that streams a large repo dump) can grow hub memory arbitrarily and produce multi-MB tool responses that blow the caller's context window; combined with the missing concurrency cap this is the memory half of the scalability bottleneck.
- **Fix:** Add a byte cap in exec.ts (`maxOutputBytes`, default 1-4 MB): stop appending once exceeded, kill the child or mark the result truncated, and append an explicit `[output truncated at N bytes]` marker.
- **Note:** Same defect as Green's G4; merged as P2 item 2 in the Purple report.

## A5 — Server version hardcoded in server.ts, drifting from package.json
- **Severity:** Low
- **file:line:** `src/server.ts:20`
- **Problem:** `new McpServer({ name: "agent-mcp-hub", version: "0.1.0" })` duplicates the version string in package.json (and a third copy in docker-compose.yml's image tag). On the next release the MCP-advertised version will silently disagree with the published package, breaking the version signal clients use for capability checks.
- **Fix:** Read the version once from package.json (e.g. `createRequire(import.meta.url)("../package.json").version` in a small `version.ts`, or inject at build time) and pass it to `McpServer`; drop the literal.

## A6 — Package description contract omits the claude agent
- **Severity:** Low
- **file:line:** `package.json:4`
- **Problem:** The description still reads "One MCP server bridging the Codex, Cursor, and OpenCode CLI agents" although the claude adapter shipped in b1c8c68 and is registered in `src/registry.ts:9`. Package discovery (npm, registry listings) gets a stale capability contract.
- **Fix:** Update the description to "One MCP server bridging the Codex, Cursor, OpenCode, and Claude CLI agents"; grep README.md for the same three-agent phrasing.
- **Note:** Same defect as Green's G12; merged as P3 item 14 in the Purple report.

## A7 — Availability probing (I/O) lives in the registry module
- **Severity:** Low
- **file:line:** `src/registry.ts:42`
- **Problem:** registry.ts is otherwise a pure selection/wiring module (allAdapters/enabledAdapters), but `checkAvailability` performs process execution, mixing two responsibilities. It is only consumed by server.ts's list_agents tool, so the coupling is gratuitous.
- **Fix:** Move `checkAvailability` into server.ts (its only caller) or a dedicated `availability.ts`, leaving registry.ts pure.
- **Filter note:** Verifier marked real=false (55%): registry.ts uses type-only `import type { Exec }` (erased at runtime) with exec passed via DI, so no runtime infrastructure dependency exists. The remaining cohesion concern is legitimate but minor — a refactor suggestion with no functional impact.
