# Plan Review Reconciliation — compose CLI-auth (round 4)

Codex plan review (03b): **NEEDS REVISION, 86** — root cause directionally correct; 3 actionable corrections + host verification. All folded in.

| Codex finding | Resolution |
|---|---|
| High — mounts only work if `mcp` (uid 1001) can READ the host files; Linux ownership/mode may block it | Documented the native-Linux uid-1001 caveat in compose + README + plan; macOS Docker Desktop mediates uids (noted as the environment assumption, not a universal guarantee). |
| Medium — "missing source path fails `up`" is WRONG; short-syntax bind mounts auto-create an empty dir → CLI silently logged-out | Corrected in compose comment, README, and 03-fix-plan: comment out mounts for CLIs you don't use; missing dir → empty → logged-out. |
| Medium — README self-contradiction on Claude (mount `~/.claude` vs `ANTHROPIC_API_KEY`) | Resolved via host verification: `~/.claude/.credentials.json` is ABSENT (macOS Keychain-backed), so the mount does NOT carry the login → claude uses `ANTHROPIC_API_KEY` in a container (enabled in compose); Linux uses the file-based mount. README prereq line and auth section now agree. |
| Low ×5 — HOME targeting, `${HOME}` vs `~`, opencode dual-dir, MCP_TOKEN separation, stdio path | Confirmed correct by Codex; no change. |

Host credential-storage check (grounds the above): codex `~/.codex/auth.json` (file, 0600), opencode `~/.local/share/opencode/opencode.db` (file), cursor `~/.local/share/cursor-agent/` (file), claude — NO `.credentials.json` → Keychain-backed on macOS.

## Verdict
All Codex findings folded in with verified facts. **Confidence: 98%.** Gate #1 passed → the implementation already reflects the corrections; proceed to gate #2 (Codex verify + four-eyes). Residual 2%: real container runtime behavior of the login mounts (unverifiable without the GHCR pull + a live `docker compose up`, which needs the user's GHCR auth) — mitigated by the documented per-CLI caveats.
