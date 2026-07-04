# Fix Plan — compose CLI-auth model (round 4)

Scope: `docker-compose.yml` + `README.md` (repo). No src/test changes → the 66 tests stay green; the gate is `docker compose config` valid + build/test/lint/format green + Codex/four-eyes.

## docker-compose.yml
- Reframe auth: make the **host-login mounts the primary path** (uncommented, complete for all four CLIs) and demote API keys to an explicit optional fallback.
- Volumes — add read-only mounts into the container's `/home/mcp` (user `mcp`, uid 1001), using `${HOME}` (portable, no `~` in the value):
  - `${HOME}/.codex:/home/mcp/.codex:ro`
  - `${HOME}/.claude:/home/mcp/.claude:ro`
  - `${HOME}/.config/opencode:/home/mcp/.config/opencode:ro`
  - `${HOME}/.local/share/opencode:/home/mcp/.local/share/opencode:ro`
  - `${HOME}/.local/share/cursor-agent:/home/mcp/.local/share/cursor-agent:ro`
- Keep the API-key env vars but comment them out with a note "usually NOT needed — the mounts above reuse your host logins; set one only if that CLI's login isn't mounted." (Commenting them out is safe: unset env in compose = the image simply doesn't receive them.)
- Add a top comment distinguishing the two auth concepts (CLI self-auth via mounts vs MCP_TOKEN = HTTP endpoint guard) and pointing to stdio as the token-free path.
- Keep `build: .`, loopback publish, MCP_TOKEN requirement, MCP_AGENTS, workspace mount, restart unchanged.
- Edge case (corrected per Codex): a host lacking one of these login dirs does NOT fail `up` — short-syntax bind mounts silently AUTO-CREATE the missing source as an empty dir, so that CLI sees an empty read-only login dir and acts logged-out. Mitigation: document "comment out the mount for any CLI you don't use." (Compose has no conditional volumes; comment-out is the accepted approach.)
- Claude/macOS (per Codex + host check): claude's OAuth token is Keychain-backed on macOS (no `~/.claude/.credentials.json` present), so the `~/.claude` mount carries config but NOT the login → claude needs `ANTHROPIC_API_KEY` in the container (enabled in compose). On Linux, claude uses `~/.claude/.credentials.json` and the mount works.
- Linux uid caveat (per Codex): host cred files owned by the host uid with restrictive modes may be unreadable to the container's uid 1001 on native Linux → use the API-key fallbacks. macOS Docker Desktop mediates uid mapping, so mounts read fine there.
- Invariant restored: the default, visible path is "reuse your existing CLI logins," matching the codex-mcp-server model. NOT a symptom patch — it removes the false key requirement at its source (the container's logged-out state) by mounting the real credentials.

## README.md
- In "Run with Docker": add an **Auth model** subsection stating (a) the CLIs self-authenticate from their own logins (mounted read-only → no API keys), (b) `MCP_TOKEN` guards the HTTP endpoint only (not a CLI key), (c) the **stdio/npx path** is the zero-config, token-free option (the codex-mcp-server model) — recommend it for simple local use.
- Note the read-only refresh caveat (drop `:ro` or set that key if a CLI must refresh its token) and the missing-login-dir caveat (comment out that mount).

## Test strategy
- No unit test (config/docs). Regression proof = `docker compose config -q` validates AND the full suite/lint/format/build stay green (unaffected). The compose-config validation is part of the verification evidence.

## Rollback
Single-file revert of the two files; no code or state touched.
