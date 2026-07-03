# Fix Plan — re-review round 2

Constraints: no new RUNTIME deps (ESLint is devDeps only); TDD for behavioral fixes; disjoint file ownership. Grouped by file.

## Group A — `src/httpServer.ts` + `tests/http.test.ts` (P1.1 fail-closed auth)
- In `startHttpServer(port, host)`, BEFORE creating/listening, add:
  ```ts
  if (!LOOPBACK_HOSTNAMES.has(host) && !process.env.MCP_TOKEN) {
    throw new Error(
      `Refusing to bind non-loopback host "${host}" without MCP_TOKEN set — the /mcp endpoint can execute code. Set MCP_TOKEN (and front it with TLS) to expose it.`,
    );
  }
  ```
  (async fn → throw becomes a rejected promise → http.ts `.catch` fatal path, before the port binds.)
- Leave the per-request token check UNCHANGED (still reads `process.env.MCP_TOKEN` each request) so the existing token tests, whose shared loopback server reads env per-request, keep passing.
- Invariant restored: no unauthenticated non-loopback exposure of a code-execution endpoint. NOT a symptom patch — it closes the default-open path at the bind boundary, not per-request.
- Tests: (a) `startHttpServer(0, "0.0.0.0")` with MCP_TOKEN unset → REJECTS with /MCP_TOKEN/; (b) with MCP_TOKEN set → resolves, then close; (c) loopback default host with no token still starts (unchanged). Existing origin/token/listen tests stay green (loopback).
- Side effects: the container now REQUIRES MCP_TOKEN to run (it binds 0.0.0.0) — handled in Group C (compose/CI provide a token). Healthz stays unauthenticated (liveness).

## Group B — `src/exec.ts` + `tests/exec.test.ts` (P2.1 bounded queue)
- `Semaphore` gains a `maxQueue` (from `MCP_MAX_QUEUE`, non-negative int). `acquire()` rejects with a typed `class ServerBusyError extends Error` (`code = "SERVER_BUSY"`, message "server busy: agent queue full, retry later") when `waiters.length >= maxQueue`. Release/FIFO logic unchanged. Default `maxQueue`: pick a value ≥ the existing semaphore test's queue depth so it stays green (read the test; use e.g. 64). The new busy test sets `MCP_MAX_QUEUE=0` for a deterministic instant-reject once all permits are busy. (Research maps ServerBusyError → HTTP 503+Retry-After conceptually; here it surfaces as an MCP `isError` result — no HTTP status to set in the stateless per-request model, so the actionable text is the contract.)
- `runCommand`/`withSlot` propagate the rejection; it flows through `runAdapter` → the tool handler's existing `catch` → `isError` result (503-equivalent) with no process spawned.
- Invariant: overload sheds load instead of growing latency unbounded. NOT a symptom patch — bounds the actual unbounded resource (the wait queue).
- Tests: set `MCP_MAX_QUEUE` small + cap small, saturate with slow spawns, assert the overflow acquirer rejects with ServerBusyError while in-flight ones still complete. Default (100) keeps the existing semaphore test green.

## Group C — `Dockerfile` + `docker-compose.yml` + `.github/workflows/ci.yml` (infra: P1.1 image, P3.2 init, P3.4 tag, P3.3 CI lint)
- Dockerfile: REMOVE `ENV HOST=0.0.0.0` (default becomes http.ts's 127.0.0.1 — safe). Keep EXPOSE/HEALTHCHECK. **P3.2 — bake tini**: `apt-get install -y tini` (Debian base) and `ENTRYPOINT ["/usr/bin/tini","--"]` before the CMD — this reaps zombie agent grandchildren + forwards signals uniformly across compose/CI/bare `docker run` (research: bake-in beats `init:true` for an image that spawns many children). So NO `init: true` needed in compose (would be redundant).
- docker-compose.yml: set `HOST: "0.0.0.0"` (needed so the published port reaches the server) and require a token: `MCP_TOKEN: ${MCP_TOKEN:?set MCP_TOKEN in .env — the /mcp endpoint executes code}`; change `image: agent-mcp-hub:0.1.0` → `image: agent-mcp-hub:${APP_VERSION:-latest}` (P3.4). Keep loopback publish `127.0.0.1:3919:3919`. (No `init:true` — tini is baked.)
- ci.yml: (P1.1) the docker smoke step must pass `-e HOST=0.0.0.0 -e MCP_TOKEN=ci-smoke-token` to `docker run` (healthz needs no token; tini is the baked ENTRYPOINT). (P3.3) add a `- run: npm run lint` step in the `test` job before build.
- Verify: `docker compose config -q` (with MCP_TOKEN set in env for the check). No test file — validated by the CI run itself.

## Group D — `package.json` + `eslint.config.js` (P3.1 engines, P3.3 lint tooling)
- package.json: `"engines": { "node": ">=22" }` (P3.1); add `"lint": "eslint ."`; add devDeps `eslint` + `typescript-eslint` (versions per research); `npm install`.
- eslint.config.mjs (new, flat config): ESLint 9 + typescript-eslint 8. Scope `src/**/*.ts` + `tests/**/*.ts`, `globalIgnores(["dist/","coverage/","node_modules/"])`. START with the UNTYPED `js.configs.recommended` + `tseslint.configs.recommended` plus explicit `no-unused-vars` (`argsIgnorePattern:"^_"`) — this bounds risk. THEN try adding type-checked `no-floating-promises` (needs `parserOptions.projectService:true`, `tsconfigRootDir: import.meta.dirname`); if it flags only a few real spots, fix them; if it explodes on the existing `void x.close()` patterns or throws "not in project" on config files, KEEP the untyped lean ruleset so `npm run lint` passes without churning working code. The deliverable is a passing lint GATE, not a rewrite. Report any GENUINE bug ESLint surfaces (e.g. a real floating promise) instead of silencing it.
- Verify: `npm run lint` exits 0; `npm test`/`typecheck`/`build` still green.

## Execution
Phase 1 parallel (no npm install, disjoint files): A, B, C. Phase 2: D (owns the only `npm install`; runs after so no node_modules race with A/B's vitest). Orchestrator then integrates: full suite + lint + build, Codex verify, four-eyes, gated push. `git pull --rebase` before push.

## Regression tests
Behavioral: P1.1 (guard reject/allow), P2.1 (busy rejection). Config/CI: P3.1/P3.2/P3.4 by inspection + `docker compose config`; P3.3 by `npm run lint` exit 0 + the CI lint step.
