# 04 — Green + DevOps (quality & delivery findings)

RE-REVIEW (round-2, post-hardening). 6 findings, raw (pre-filter). Verification outcomes are cross-referenced in `07-filtered.md`.

## G1 — CI produces no retained/published image — no deployable artifact or rollback target
- **severity:** medium
- **file:** `.github/workflows/ci.yml:58-74`
- **problem:** The docker job builds `agent-mcp-hub:ci`, smoke-tests it, then runs `docker system prune -af` (line 73, `if: always()`) which deletes the image. Nothing is pushed to a registry (GHCR). A 'green' release therefore yields zero versioned, deployable artifact and no rollback target — every deploy must rebuild from source, which is non-reproducible because the default image build runs `curl https://cursor.com/install | bash` (Dockerfile:29) with no integrity pin. G7's fix added the smoke test but left the 'push to GHCR' step unimplemented.
- **fix:** On push to main, after the smoke test passes, tag and push a versioned image before pruning: add a `docker/login-action` (or `docker login ghcr.io`) step, then `docker tag agent-mcp-hub:ci ghcr.io/<owner>/agent-mcp-hub:${{ github.sha }}` and `:latest`, `docker push` both, and make the push job `needs: [test, secrets]` so the secret scan gates publication. Retain a versioned tag per release so a prior tag is an immediate rollback target.

## G2 — No SIGTERM handling — in-flight agent runs and HTTP connections killed abruptly on deploy/rollback
- **severity:** medium
- **file:** `src/httpServer.ts:43`
- **problem:** Neither http.ts nor httpServer.ts registers a SIGTERM/SIGINT handler (grep confirms none in src/). On `docker stop` / rolling redeploy, Node (PID 1) receives SIGTERM and exits immediately with no graceful drain: the HTTP server never calls `.close()`, in-flight `/mcp` requests are dropped mid-response, and running agent children (spawned `detached` in their own process groups) are not signalled — they survive until the container cgroup is torn down, wasting tokens/CPU during the grace window. This undermines zero-downtime deploy/rollback readiness.
- **fix:** In `src/http.ts`, capture the returned server and add: `const shutdown = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 10_000).unref(); }; process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);`. For full correctness also track live child PIDs in exec.ts and group-kill them on shutdown so detached agent trees are reaped, not orphaned.

## G3 — Container runs Node as PID 1 with no init — zombie reaping / signal-forwarding gap
- **severity:** low
- **file:** `docker-compose.yml:29`
- **problem:** The runtime image `CMD ["node", "dist/http.js"]` (Dockerfile:44) makes Node PID 1, and docker-compose.yml sets no `init: true` and Dockerfile has no tini/dumb-init. Node does not reap reparented orphans, so any detached agent grandchild that outlives its parent and gets reparented to PID 1 becomes a zombie; with `restart: unless-stopped` and long-lived operation these accumulate. Architecture finding A1 flagged the missing init but the applied fix was only process-group kill, not adding an init.
- **fix:** Add `init: true` under the service in docker-compose.yml (Docker injects tini as PID 1 to reap zombies and forward signals). For non-compose runners, add `ENTRYPOINT ["/usr/bin/tini", "--"]` after `apt-get install ... tini` in the Dockerfile runtime stage.

## G4 — `docker system prune -af` on self-hosted runner is host-wide and destructive
- **severity:** low
- **file:** `.github/workflows/ci.yml:53`
- **problem:** The docker job runs `docker system prune -af` at start (line 53) and end (line 73). The `-a` flag removes ALL images not attached to a running container across the entire daemon, plus all build cache — not scoped to this build. On a self-hosted daemon this can delete images/build cache belonging to any concurrently-running or recently-completed job on the same host, causing spurious failures elsewhere. Mitigated somewhat by the repo-dedicated runner label, but still fragile if the daemon is ever shared.
- **fix:** Scope the reclamation: replace `docker system prune -af` with targeted cleanup — `docker rmi agent-mcp-hub:ci || true` plus `docker builder prune -f --filter until=24h` and `docker image prune -f --filter until=24h` — so only this build's artifacts and genuinely stale resources are removed, not other jobs' live images.

## G5 — No lint/format gate in CI or repo
- **severity:** low
- **file:** `.github/workflows/ci.yml:36-39`
- **problem:** The test job runs `npm test`, `typecheck`, and `build` but there is no lint step, and the repo has no ESLint/Prettier config (ls confirms none). Strict `tsc` catches type errors but not unused code, import hygiene, floating promises, or style drift — quality regressions ship green. This is a gap for a release-quality gate.
- **fix:** Add ESLint with `@typescript-eslint` (flat config `eslint.config.js`) plus the `no-floating-promises` and `no-unused-vars` rules, add a `"lint": "eslint ."` script to package.json, and insert `- run: npm run lint` in the test job before `npm run build`.

## G6 — engines `node>=20` conflicts with the runtime's Node 22 requirement
- **severity:** low
- **file:** `package.json:9`
- **problem:** package.json declares `"engines": { "node": ">=20" }`, but the Dockerfile comment (line 17) states `@anthropic-ai/claude-code` needs Node 22+, and CI (ci.yml:34) and both Docker stages use Node 22. A user who `npm i -g agent-mcp-hub` on Node 20 passes the engines check, and the hub itself runs, but the claude adapter's spawned CLI fails at runtime — a silent, hard-to-diagnose partial breakage.
- **fix:** Set `"engines": { "node": ">=22" }` in package.json to match the CI/Docker baseline and the wrapped-CLI requirement, so incompatible installs fail fast at install time.
