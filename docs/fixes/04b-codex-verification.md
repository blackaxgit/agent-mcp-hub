# Codex Fix Verification (gate #2, outside engine)

Run: codex-rescue, read-only, 2026-07-03. Status: ran successfully. Verdict: **AGREES — all 14 fixes genuinely resolved, confidence 94/100.** No symptom patches found.

Per-finding: all FIXED with file:line evidence — #1 process-group kill (exec.ts:102/107/44, ESRCH-swallow + EPERM fallback), #2 output cap (stops accumulating, no concat on reject), #3 semaphore (withSlot finally covers all paths), #8 single-sourced runAdapter, #12 observability (one stderr line, no prompt/output), #13 version from package.json, #4 listen reject, #9 timingSafeEqual(sha256), #5 pinned CLIs, #10 PORT healthcheck, #6 prepublishOnly, #14 description, #7 CI image smoke.

Codex's sandbox EPERM on `npm test`/`npm run build` is its own read-only sandbox (typecheck passed there); orchestrator ran the real suite: 62/62 green, clean build.

Residual risks Codex noted (both intentional/documented): docker smoke runs on main-push not PRs (disk-constrained self-hosted runner — documented CI decision); `cursor-agent` stays installer-based (vendor has no checksum to pin — recorded in TEMPLATE-DEVIATION scope / Dockerfile comment).
