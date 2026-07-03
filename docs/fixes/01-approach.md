# Approach — re-review round 2 (verified 2026)

(Round-1 approach preserved in git history.) Research (MCP spec + Node/Docker/ESLint docs) confirms all four designs:

1. **Fail-closed bind (P1.1)** — MCP Streamable-HTTP spec: Origin validation is **MUST**; loopback-only bind and auth are **SHOULD**. Our "refuse to bind non-loopback without MCP_TOKEN" is a deliberate policy STRICTER than the spec, justified because this server executes code (exposure = RCE). Frame it that way in a code comment. Guard at the bind boundary (startHttpServer), per-request check unchanged. `0.0.0.0` is the explicit opt-in to public + then a token is mandatory. Origin carve-out for header-absent (non-browser) requests is standard.
2. **Bounded-queue backpressure (P2.1)** — semaphore with fixed permits + bounded FIFO wait-queue; at cap, `acquire()` rejects with typed `ServerBusyError` (`code:"SERVER_BUSY"`) → surfaces as an MCP `isError`. Queue is a shock absorber (small), not a buffer. Env `MCP_MAX_QUEUE`; default kept ≥ existing test depth; busy test uses `MCP_MAX_QUEUE=0` for deterministic instant-reject.
3. **Container init (P3.2)** — bake `tini` as `ENTRYPOINT ["/usr/bin/tini","--"]` (Debian `apt-get install tini`). tini as PID 1 reaps re-parented zombie grandchildren and forwards signals, uniformly across compose/CI/bare `docker run` — preferred over `init:true` for an image that spawns many child processes. No `init:true` in compose (redundant with baked tini).
4. **ESLint (P3.3)** — ESLint 9 + typescript-eslint 8 flat config (`eslint.config.mjs`), scoped src+tests, dist ignored. Start untyped-recommended + no-unused-vars to bound risk; add type-checked `no-floating-promises` only if it doesn't explode on existing `void`-discard patterns. Lint is a GATE, not a rewrite.

Gate #1: root causes all ≥97% (all re-review CONFIRMED + confirmed here); Codex plan review pending in 03b.
