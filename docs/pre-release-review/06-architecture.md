# 06 — Architecture (structural findings)

RE-REVIEW (round-2, post-hardening). 5 findings, raw (pre-filter). Verification outcomes are cross-referenced in `07-filtered.md`.

## A1 — run_all never signals failure to callers (isError always absent)
- **severity:** medium
- **file:** `src/server.ts:141`
- **problem:** The per-agent tool sets isError:true on non-zero exit / thrown exec errors (lines 89-106), but run_all folds every outcome — including all-agents-failed — into a plain content array and returns without isError. A programmatic MCP client cannot distinguish full success from total failure except by string-parsing '## name (failed)' markdown, so orchestrators that branch on isError will treat a completely failed fan-out as success. This is an API-contract inconsistency between two tools that share the same execution core.
- **fix:** After building `content`, compute failure state from the settled results and set isError when nothing succeeded: `const anyOk = settled.some((o,i)=> o.status==='fulfilled' && o.value.exitCode===0); return anyOk ? { content } : { isError: true, content };` (or, for a stronger contract, attach a per-agent structured status array). Add a test asserting run_all returns isError:true when every adapter exits non-zero.

## A2 — Concurrency semaphore has no acquisition timeout, queue bound, or fast-fail backpressure
- **severity:** medium
- **file:** `src/exec.ts:69`
- **problem:** MAX_CONCURRENT_AGENTS caps spawns (fixing the fork-bomb), but Semaphore.acquire() only ever resolves — it cannot reject or time out, and there is no cap on the waiter queue. Because the child timeoutMs starts only after the slot is acquired (line 118), a burst of POST /mcp requests under a saturated pool blocks indefinitely with no backpressure signal; latency grows unbounded and clients hit their own timeouts while holding sockets/promises open. The remediation note for prior finding A2 called for 'queue OR fast-fail'; only the queue half shipped, so the endpoint has no load-shedding path.
- **fix:** Add a bounded-wait option to the semaphore: accept a maxQueue / acquireTimeoutMs and reject with a typed 'server busy, retry' error when exceeded, then surface it in server.ts as an isError result (HTTP 503-equivalent). Env-gate via e.g. MCP_MAX_QUEUE. Minimum viable: cap `waiters.length` and reject acquire() once the queue is full so callers get an actionable busy error instead of an unbounded stall.

## A3 — Lightweight liveness probe (list_agents) competes for the heavyweight agent-execution semaphore
- **severity:** low
- **file:** `src/server.ts:73`
- **problem:** checkAvailability runs each adapter's `--version` through the injected exec, which is runCommand → withSlot → the same process-wide semaphore used for real agent runs (registry.ts:44). This couples a cheap liveness/inventory concern to the scarce execution budget: under load, list_agents blocks behind long-running agent invocations (and vice versa), so a monitoring/UX call's latency now depends on execution saturation. Two responsibilities with very different SLAs share one throttle.
- **fix:** Bypass the execution semaphore for probes — either give checkAvailability its own tiny exec path (direct runCommandInner, or a dedicated small semaphore) or run `--version` without acquiring the main pool. Keep the 10s bound. This decouples inventory latency from execution load.

## A4 — Server version is now single-sourced, but docker-compose image tag still hardcodes it
- **severity:** low
- **file:** `docker-compose.yml:4`
- **problem:** Prior finding A5 was fixed by reading version from package.json in server.ts, but a third copy remains: `image: agent-mcp-hub:0.1.0`. On the next release this tag must be bumped by hand in lockstep with package.json; if missed, the built/published image tag silently disagrees with the advertised MCP server version, defeating the single-source goal.
- **fix:** Reference the version indirectly or drop the pin: use `image: agent-mcp-hub:${APP_VERSION:-latest}` (or omit `image:` and let compose name it), and derive APP_VERSION from package.json in the release script. Add a CI check asserting the compose tag matches package.json version.

## A5 — I/O-bearing checkAvailability lives in the otherwise-pure registry module
- **severity:** low
- **file:** `src/registry.ts:42`
- **problem:** registry.ts is a pure selection/wiring module (allAdapters/enabledAdapters) except for checkAvailability, which performs process execution and is consumed only by server.ts's list_agents. The infra dependency is DI'd (type-only `import type { Exec }`), so there is no hard runtime coupling — this is a cohesion nit, not a layering violation — but it mixes wiring with a runtime probe in a single file. Low impact; include for completeness.
- **fix:** Move checkAvailability into server.ts (its only caller) or a dedicated availability.ts, leaving registry.ts a pure adapter-selection module. No behavior change.
