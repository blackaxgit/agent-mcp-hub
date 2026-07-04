# Root-Cause Analysis — compose CLI-auth model (round 4)

(Prior rounds preserved in git history.) Scope (user-confirmed): repo `docker-compose.yml` + `README.md` only; no src changes.

## Issue: compose presents API keys as the primary auth, contradicting the "use the CLI" design
- Symptom: `docker compose up` appears to require `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`/`CURSOR_API_KEY`, even though the wrapped CLIs already authenticate themselves via their own stored logins (`codex login` → `~/.codex`, `claude` → `~/.claude`, `opencode auth login`, `cursor-agent login`). The reference this project is modeled on (tuannvm/codex-mcp-server) needs NO API key — it runs as a host stdio process and the CLI uses its stored login.
- Backward trace: `docker-compose.yml` lists the three API keys under "Credential passthrough for the wrapped CLIs" as the visible path, while the login-dir reuse is a 2-line COMMENTED afterthought ("Alternative to API keys") that is also INCOMPLETE — it omits `~/.claude`, `~/.config/opencode`, and `~/.local/share/cursor-agent`. A fresh container is logged out, so with the mounts commented the only working path appears to be keys.
- Wrong assumption: "a container needs API keys to authenticate the CLIs." False — mounting the host login dirs read-only makes the containerized CLIs reuse the existing logins; keys are only a fallback.
- Second, smaller issue: `MCP_TOKEN` is documented as "shared-secret auth" without distinguishing it from CLI credentials, so users conflate the HTTP-endpoint guard with a CLI key. It is NOT a CLI credential — it only protects the code-executing `/mcp` network endpoint (and there is a token-free path entirely: stdio/npx).
- Confidence: 99% (config/docs design defect, empirically confirmed — all four host login dirs exist and the CLIs are logged in; the deploy-dir copy was already corrected the same way and `docker compose config` validated).

## Not a code bug
No src change: the adapters already spawn the CLIs (which self-authenticate); the fix is making the compose reuse host logins and the docs explain the two distinct auth concepts + the stdio zero-config path.

Gate #1: root cause ≥97%; Codex plan review in 03b.
