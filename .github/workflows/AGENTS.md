# AGENTS.md — `.github/workflows/`

> Overlay for CI and the release/publish pipeline. **This file wins over the root `AGENTS.md` for anything under `.github/workflows/`.**
> Every rule here is load-bearing: getting one wrong silently breaks publishing, or kills every workflow run.

## The four workflows

| File | Trigger | What it does |
|---|---|---|
| `ci.yml` | **push to `main`**, pull_request | `secrets` (gitleaks) + `test` (build, typecheck, lint, format:check, coverage). Self-hosted runner. **Note:** pushes to non-`main` branches do NOT run CI — only the PR does. |
| `release-please.yml` | push to `main` | **The entry point for releases.** Opens/updates the Release PR; on merge it tags + creates the Release, then calls `publish.yml` in the same run (gated on `release_created`). |
| `publish.yml` | `workflow_call`, `workflow_dispatch` | Job `npm` = npm publish via OIDC (`ubuntu-latest`). Job `registry` = MCP Registry publish (self-hosted, `continue-on-error`). |
| `release.yml` | `workflow_dispatch` | Manual escape hatch → calls `publish.yml`. It has `id-token: write`, but see the Trusted Publisher rule: it will **auth-fail** unless the npm Trusted Publisher also authorizes `release.yml`, which today it does not. |

## Publishing rules — read before touching `publish.yml` or `release-please.yml`

- **The npm Trusted Publisher must name the ENTRY-POINT workflow — `release-please.yml`, NOT `publish.yml`.**
  npm authorizes the workflow that **starts** the run. In the release path, `publish.yml` is reached via `workflow_call` (it also has a `workflow_dispatch` trigger, but that is not how releases run), so npm never sees `publish.yml` as the entry point. Naming `publish.yml` produces a badly misleading error:
  ```
  npm error code E404
  npm error 404 Not Found - PUT https://registry.npmjs.org/agent-mcp-hub
  npm error 404  ... you do not have permission to access it
  ```
  **An E404 on PUT means UNAUTHENTICATED — not "package missing."** Don't go hunting for a missing package.

  > ⚠️ **`PUBLISHING.md` step 4 is STALE:** it still instructs setting the Trusted Publisher workflow to `publish.yml`. That value **fails**. The working value — verified by an actual failed-then-successful publish of 0.5.1 — is **`release-please.yml`**. Trust this overlay, not that step, until the runbook is corrected.

- **`id-token: write` is required on BOTH the calling job (in `release-please.yml`) and the reusable workflow's job (in `publish.yml`).** Dropping it from either silently breaks OIDC.

- **npm OIDC trusted publishing does NOT work on self-hosted runners.** The `npm` job must stay on **`ubuntu-latest`**. (GitHub OIDC *token minting* does work on self-hosted — which is why the `registry` job can stay there.) Do not "consolidate" the npm job onto the self-hosted runner.

- **The `registry` job is `continue-on-error: true` on purpose — keep it.** npm publish happens first and is irreversible; the MCP Registry is preview/discovery, not the install path. Without this, a registry flake would fail the whole workflow *after* the package is already live on npm.

- **This repo is PRIVATE, so publish must use `--no-provenance`.** npm provenance requires a *public* source repo; with provenance on, the publish fails. If the repo is ever made public, drop the flag and restore `publishConfig.provenance`.

- **npm ≥ 11.5.1 is required for trusted publishing,** and `setup-node` on Node 22 ships npm 10.x — which is why `publish.yml` has an explicit `npm install -g npm@latest` step. Don't delete it.

- **Never reintroduce `NODE_AUTH_TOKEN` / `NPM_TOKEN`.** OIDC supplies the credential; a stale or empty token env var *overrides* OIDC and breaks the publish.

- **A GitHub Release created by release-please with the default `GITHUB_TOKEN` does NOT trigger another workflow's `on: release: published`** (GitHub's anti-recursion rule). That is precisely why publishing is invoked as a reusable workflow *inside the same run* rather than from a release trigger. Do not "simplify" it into a `release:`-triggered workflow — it will never fire.

## Repo settings this pipeline depends on (not in code — easy to miss)

- **Actions allowlist.** The repo restricts Actions to GitHub-owned plus an explicit allowlist. **Adding a new third-party action requires allowlisting it first** — otherwise *every* workflow run dies as `startup_failure` with **zero jobs and no logs**, which looks exactly like a YAML syntax error and is routinely misdiagnosed.
  `googleapis/release-please-action` is currently the **only third-party action actually in use**. (`gitleaks/gitleaks-action` is still on the allowlist but is **vestigial** — CI now runs the gitleaks binary directly, see below.)
- **"Allow GitHub Actions to create and approve pull requests" must stay ON** — release-please cannot open its Release PR without it (it fails with `GitHub Actions is not permitted to create or approve pull requests`).

## Conventions

- **Pin every action by commit SHA**, with a `# vX` trailing comment:
  ```yaml
  - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
  ```
- **The self-hosted runner label array is exact** — keep it verbatim:
  ```yaml
  runs-on: [self-hosted, linux, x64, ubuntu-2404, "repo:agent-mcp-hub"]
  ```
- **Never interpolate untrusted input** (`github.event.*` titles/bodies/refs) directly into a `run:` block — pass it via `env:` and quote it.

## gitleaks in CI

The `secrets` job runs the **pinned gitleaks binary with SHA-256 verification**, not `gitleaks-action`:

```yaml
dir="$(mktemp -d)"
curl -sSfL ".../gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" -o "$dir/gitleaks.tar.gz"
echo "${GITLEAKS_SHA256}  ${dir}/gitleaks.tar.gz" | sha256sum -c -
```

Two reasons, both load-bearing:
1. `gitleaks-action` downloads to a **fixed `/tmp/gitleaks.tmp`**, which **collides across runs on the self-hosted runner** (`/tmp` is not wiped between jobs) → `Error: parameter 'file' is required`.
2. Running an unverified downloaded binary is a supply-chain hole; the checksum check **fails closed**.

If you bump the gitleaks version you **must** also update `GITLEAKS_SHA256` from that release's `checksums.txt`, or the job will (correctly) fail.

## `mcp-publisher` is pinned the same way

The `registry` job in `publish.yml` installs `mcp-publisher` at a **fixed version with a fail-closed SHA-256 check** — it does **not** pipe `releases/latest` straight into execution:

```yaml
MCP_PUBLISHER_VERSION: "1.8.0"
# full digest, from that release's registry_<version>_checksums.txt (public, not a secret)
MCP_PUBLISHER_SHA256: "1370446bbe74d562608e8005a6ccce02d146a661fbd78674e11cc70b9618d6cf"
echo "${MCP_PUBLISHER_SHA256}  mcp-publisher.tar.gz" | sha256sum -c -
```

Same consequence as gitleaks: **bumping `MCP_PUBLISHER_VERSION` requires updating `MCP_PUBLISHER_SHA256`**, or the step fails. Both values are plain env entries, not secrets — a release checksum is public. Don't "unpin to latest" to dodge a checksum update; that is the supply-chain hole this closes.

## Permission Boundaries (stricter than the repo root)

**Always allowed:** read any workflow; read run logs; explain a run failure.

**Ask first:** any edit to a workflow file; adding an action (which also needs allowlisting); changing runner labels, job names, or triggers.

**Never without explicit human approval:** changing publish auth (OIDC / Trusted Publisher / tokens), removing `--no-provenance`, moving the `npm` job off `ubuntu-latest`, removing `continue-on-error` from the `registry` job, re-running a publish job, or anything else that could cause an `npm publish`. **Publishing is irreversible.**
