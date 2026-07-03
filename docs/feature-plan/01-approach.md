# Approach Research — Feature 2 (verified 2026-07-03)

(v0.1 research preserved in git history at this path.)

## Claude Code CLI (verified against local CLI v2.1.199 + official docs)
- **Adapter invocation:** `args: ["-p", "--output-format", "text", ("--model", m)]`, `stdin: prompt`. Empirically confirmed: piped stdin with no positional arg returns clean text, exit 0. `text` is the default print-mode format (kept explicit, matching the cursor adapter).
- **Injection safety:** stdin-delivered prompts starting with `-` are never parsed as flags — same guarantee as codex/cursor adapters.
- **Model flag:** `--model` accepts aliases (`sonnet`, `opus`, `fable`) or full model names.
- **Availability probe:** `claude --version` → exit 0 ("2.1.199 (Claude Code)").
- **Permissions:** plain text Q&A needs no permission flags; only tool-driving prompts would need `--allowedTools`/`--permission-mode` — out of scope for the wrapper (the wrapped CLI decides).
- **`--bare` decision — NOT used:** `--bare` gives reproducible container runs but restricts auth strictly to `ANTHROPIC_API_KEY`/apiKeyHelper (OAuth/keychain never read). The hub's convention is reusing host CLI logins (codex/cursor/opencode all do), so non-bare keeps local stdio users on OAuth working. Docs note `ANTHROPIC_API_KEY` for containers. Revisit if `--bare` becomes the `-p` default as announced.
- **Stdin cap:** 10MB piped-prompt limit (CLI exits non-zero over cap) — surfaced through the existing non-zero-exit error path; no code needed.

## Docker install
- `npm install -g @anthropic-ai/claude-code`; needs **Node 22+** (v2.1.198+) — our image is `node:22-bookworm-slim`, compliant (only EBADENGINE warnings on older, but we're fine). Ships a native binary (linux-x64/arm64 incl. musl); Debian 10+ OK. No `sudo npm`.
- Container auth: `ANTHROPIC_API_KEY` env (primary) — added to compose passthrough.

## MCP_AGENTS toggle
No external prior art needed — env allowlist matches the project's existing `MCP_TOKEN`/`MCP_ALLOWED_ORIGINS` convention; fail-fast on unknown names per the project's reliability standard (actionable errors at startup, not silent skips).
