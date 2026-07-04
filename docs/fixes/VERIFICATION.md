# VERIFICATION — compose CLI-auth model (round 4, 2026-07-04)

(Prior rounds preserved in git history.) Branch: `fix/compose-cli-auth`. No src/test changed → the 66 tests stay green; the gate is config validity + docs accuracy.

Gates: **`docker compose config` valid · 66/66 tests · lint · format:check · build all green.**
Gate #2: Codex fix-verify **AGREES (95)** · four-eyes double-check **PASS (93)**.

## Issue → resolution

```
Issue: compose required API keys, hiding that the wrapped CLIs self-authenticate → FIXED
Root cause: fresh container is logged out + login mounts were commented/incomplete + keys framed as primary
Fix: docker-compose.yml mounts host CLI login dirs read-only (codex/claude/opencode×2/cursor) as the
  primary path; API keys demoted to optional (ANTHROPIC_API_KEY enabled for claude/macOS Keychain reality);
  README rewritten with the two-concept auth model + stdio zero-config path.
Regression proof: `docker compose config -q` validates; full suite/lint/format/build unaffected (66/66).
Codex: agrees (95). Four-eyes: PASS (93). Confidence: 98%.
```

## Codex plan-review findings (03b, NEEDS REVISION 86) — all folded in and re-verified FIXED
1. Native-Linux uid-1001 read caveat — documented (compose + README).
2. "Missing mount fails `up`" was WRONG → corrected to "auto-creates empty dir → CLI logged-out; comment out unused."
3. Claude contradiction — resolved via host check (`~/.claude/.credentials.json` absent → macOS Keychain-backed), so claude uses `ANTHROPIC_API_KEY` in a container; codex/opencode/cursor use file mounts. README prereq + auth section now agree.

## Four-eyes precision tweaks applied
- README prereq line scoped to "containers **on macOS** use ANTHROPIC_API_KEY".
- Added the cost note: `ANTHROPIC_API_KEY` bills pay-per-token, separate from a Claude Pro/Max subscription.

## Honest caveats
- The login mounts' actual runtime behavior in a live container is not exercised here (needs the GHCR pull + `docker compose up`, which requires the user's GHCR auth). Mitigated by documented per-CLI caveats; `docker compose config` validates the file.
- macOS Docker Desktop mediates uid mapping (mounts read fine); native Linux may need the API-key fallback — documented.

## Double-check: PASSED
Four-eyes confirmed all items FIXED with file:line evidence, both behavioral facts (Keychain reality, RO+key coherence) correct, no over-promises, changed files limited to docker-compose.yml/README.md/docs. All bars ≥97% for the fix (config validity + docs accuracy); overall confidence 98%.
