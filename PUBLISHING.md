# Publishing runbook

How to publish `agent-mcp-hub` to the npm registry and the MCP Registry. The
first release is bootstrapped by hand; after that, releases are automatic via
release-please + npm OIDC trusted publishing.

## Prerequisites

- npm account with write access to `agent-mcp-hub`.
- Repository admin on `github.com/blackaxgit/agent-mcp-hub`.
- `gh` CLI authenticated.

---

### 1. One-time: npm login

```bash
npm login
```

### 2. Bootstrap the first publish

> A brand-new npm package **cannot** use OIDC trusted publishing for its first
> publish (npm/cli#8544). Publish manually once, then tag, then create the
> release. `prepublishOnly` runs build + typecheck + coverage first.

```bash
npm publish
git tag v0.5.0 && git push origin v0.5.0
gh release create v0.5.0 --generate-notes
```

### 3. Re-anchor release-please to the v0.5.0 tag

`release-please-config.json` already carries an interim `bootstrap-sha` (the
commit that was HEAD when publishing was set up). Once the `v0.5.0` tag exists,
re-point it at that tag's commit so the baseline matches the published release:

```bash
git rev-parse v0.5.0
```

Replace the `bootstrap-sha` value in `release-please-config.json` with that SHA,
then commit:

```bash
git add release-please-config.json && git commit -m "chore: re-anchor bootstrap-sha to v0.5.0"
git push
```

(Once the `v0.5.0` tag exists, release-please prefers the tag over
`bootstrap-sha`, so this step is belt-and-suspenders.)

### 4. Configure npm Trusted Publishing

On `npmjs.com`:

1. Package `agent-mcp-hub` → Settings → Trusted Publisher.
2. Add publisher:
   - **Owner:** `blackaxgit`
   - **Repository:** `agent-mcp-hub`
   - **Workflow:** `publish.yml`
   - **Environment:** (leave blank)
   - **Allowed action:** `npm publish` (required for publishers created after 2026-05-20).
3. Delete any `NPM_TOKEN` secret from the GitHub repository — OIDC needs no token.

### 5. MCP Registry

The CI `registry` job runs `mcp-publisher login github-oidc` and publishes under
the `io.github.blackaxgit/*` namespace automatically when the release workflow
runs (no device flow in CI). The registry validates that the published npm
package's `mcpName` matches `server.json`'s `name`.

**Local alternative** (testing / out-of-band):

```bash
mcp-publisher login github
mcp-publisher publish
```

### 6. Flip the local MCP registration to the pinned npm build

```bash
claude mcp remove agent-hub -s user
claude mcp add agent-hub -s user -- npx -y agent-mcp-hub@0.5.0
```

### 7. Thereafter: fully automatic

- Conventional-commit changes on `main` → release-please opens a Release PR.
- Merging the Release PR → GitHub tag + Release created + `publish.yml` invoked
  on the same run → `npm publish` (OIDC) → MCP Registry publish.
