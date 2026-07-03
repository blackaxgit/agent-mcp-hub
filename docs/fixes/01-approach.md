# Approach — 2026 Node subprocess-hardening patterns (verified)

Research (official Node child_process/crypto docs + current community idiom) confirms every fix-plan technique. Canonical patterns adopted:

1. **Tree kill** — `spawn(cmd, args, { detached: true, stdio:["ignore"|"pipe","pipe","pipe"] })` makes the child a process-group leader; `process.kill(-child.pid, "SIGKILL")` reaps the whole subtree. Do NOT `unref()` (we await output; detached does not change piping). Swallow only `ESRCH` (group already gone); let EPERM/others surface. POSIX-identical on Linux+macOS (Windows N/A — target is the container + mac dev). Decision: SIGKILL directly to the group (deterministic, matches existing immediate-kill timeout semantics) rather than SIGTERM→SIGKILL escalation, to keep the settled/close logic and timeout tests simple.
2. **Output cap** — count `buf.length` (bytes, not string length) across chunks; on breach set a `done` guard, `killGroup`, and resolve/reject from the single `close` handler (not at breach). Hard-slice the buffer to the limit so a late large chunk can't blow memory.
3. **Semaphore** — hand-rolled ~15-line async semaphore (no `p-limit` dep): FIFO, hands the permit straight to the next waiter on release, idempotent release token; always release in `finally`. Fixes the deadlock/leak failure modes.
4. **listen reject** — `server.once("error", reject)` + `server.once("listening", resolve)` BEFORE `listen`, each removing the other on fire (so post-startup socket errors aren't stolen by a settled promise).
5. **Token compare** — `timingSafeEqual(sha256(provided), sha256(expected))`; hashing both sides to fixed 32 bytes gives constant-time AND length-safe comparison (raw `timingSafeEqual` throws on length mismatch and leaks length).

Shared helper `killGroup(pid, signal)` (ESRCH-swallow) is the one place cross-platform correctness lives; #1 and #2 both use it.
