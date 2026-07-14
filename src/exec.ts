import { spawn, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { stripAnsi } from "./ansi.js";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export type Exec = (
  binary: string,
  args: string[],
  opts?: {
    cwd?: string;
    timeoutMs?: number;
    idleTimeoutMs?: number;
    input?: string;
    maxOutputBytes?: number;
    /** Fired synchronously once per ACCEPTED output chunk. Never awaited. */
    onActivity?: () => void;
    /**
     * Line patterns the CLI prints on its DIAGNOSTIC stream (stderr) when it
     * cannot reach its backend. Matched against stderr ONLY: the model's answer
     * arrives on stdout, so a model that quotes one of these phrases can never
     * trip the detector.
     */
    stallSignatures?: readonly RegExp[];
    /**
     * How many distinct reconnect cycles (each cycle = one "attempt N" line) the
     * child must emit before we treat the stall as permanent. Default 2 — a
     * single legitimate reconnect cycle emits exactly one attempt line.
     */
    stallAttemptLimit?: number;
    /**
     * Absolute strike cap for signatures that carry no attempt number (e.g. a
     * repeated "RetriableError: …"). Default 4.
     */
    stallStrikeLimit?: number;
    /**
     * Env-var names to DELETE from the child's environment. Least-privilege
     * denylist that keeps exec generic — it never learns which adapter owns
     * which key. Callers pass the OTHER agents' credential var names (the union
     * of every agent's apiKeyEnv MINUS the one being spawned) so a compromised
     * or prompt-injected child cannot read a sibling agent's key FROM THE ENV.
     * This is env-var isolation, not a full secret boundary: `HOME` is preserved
     * (agents need their config there), so an agent can still read a sibling's
     * on-disk credential file — hardening the env is necessary but not sufficient.
     * Every other var (PATH, HOME, proxy/CA/XDG/locale) is preserved. Undefined or
     * empty leaves behavior identical to inheriting the full parent env.
     */
    stripEnvKeys?: readonly string[];
    /**
     * Env vars to SET on the child, applied AFTER stripEnvKeys (so an override
     * here always wins). Used to harden a subprocess against its own working
     * tree — e.g. neutralising git's config search path so an untrusted repo's
     * `.git/config` / global / system config cannot execute code during
     * `git diff` / `git status`. Keys set here are never treated as strippable.
     */
    env?: Readonly<Record<string, string>>;
  },
) => Promise<ExecResult>;

/** Positive finite integer only; NaN/0/negative/non-integer all fall back to `fallback`. */
function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * TOTAL runtime cap (never reset). Parsed once at module load; override via
 * MCP_AGENT_TIMEOUT_MS. Raised to 30 min so long PRODUCTIVE runs survive — the
 * idle timeout, not this, is the fast hung-agent detector.
 */
export const DEFAULT_TIMEOUT_MS = parsePositiveInt(process.env.MCP_AGENT_TIMEOUT_MS, 1_800_000);

/**
 * IDLE (inactivity) cap: reset on every accepted output chunk. Parsed once at
 * module load; override via MCP_AGENT_IDLE_TIMEOUT_MS. Generous default so a
 * slow-but-streaming CLI is not killed mid-work.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = parsePositiveInt(
  process.env.MCP_AGENT_IDLE_TIMEOUT_MS,
  300_000,
);

export const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
export const DEFAULT_STALL_ATTEMPT_LIMIT = 2;
export const DEFAULT_STALL_STRIKE_LIMIT = 4;

/**
 * Hard ceiling on any single timer (total or idle). Two jobs:
 *  1. Correctness — `setTimeout` truncates a delay > 2^31-1 ms (~24.8 days) to
 *     1ms and fires it IMMEDIATELY, so an unclamped huge `timeoutMs` would kill
 *     the child the instant it starts. 24h is safely under that boundary.
 *  2. Load-shedding — a single run can hold a concurrency slot for at most 24h,
 *     so a caller cannot pin all slots for weeks with an enormous `timeoutMs`.
 */
export const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/** Clamp a caller-supplied timer to [1, MAX_TIMEOUT_MS]; floors non-integers. */
export function clampTimer(ms: number): number {
  if (!Number.isFinite(ms)) return MAX_TIMEOUT_MS;
  return Math.min(Math.max(1, Math.floor(ms)), MAX_TIMEOUT_MS);
}

/** Positive finite integer only; NaN/0/negative/non-integer all fall back to 4. */
function parseConcurrency(raw: string | undefined): number {
  return parsePositiveInt(raw, 4);
}

/** Non-negative finite integer only; NaN/negative/non-integer all fall back to 100. */
function parseMaxQueue(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 100;
}

/**
 * Cap on children spawned concurrently across the process. Parsed once at module
 * load; override via MCP_MAX_CONCURRENT_AGENTS.
 */
export const MAX_CONCURRENT_AGENTS = parseConcurrency(process.env.MCP_MAX_CONCURRENT_AGENTS);

/**
 * Thrown when every permit is busy AND the wait queue is already full. Overload
 * sheds load here instead of growing latency unbounded — the caller retries
 * later. Surfaces through runCommand → runAdapter → the tool handler's catch as
 * an `isError` result (the 503-equivalent in the stateless per-request model).
 */
export class ServerBusyError extends Error {
  readonly code = "SERVER_BUSY";
  constructor() {
    super("server busy: agent queue full, retry later");
    this.name = "ServerBusyError";
  }
}

/** Thrown when the child process fails to spawn (binary missing / not on PATH). */
export class SpawnError extends Error {
  readonly code = "spawn";
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SpawnError";
  }
}

/**
 * Thrown when `cwd` does not exist (or is not a directory). Checked BEFORE spawn
 * because both a missing binary and a missing cwd surface as bare ENOENT from
 * spawn, and collapsing them is actively misleading: a caller passing a repo path
 * the server cannot see was told "codex was not found on PATH" while codex was
 * installed and healthy. Distinguishing them up front makes the real fault legible.
 */
export class InvalidCwdError extends Error {
  readonly code = "invalid_cwd";
  constructor(readonly cwd: string) {
    super(`cwd does not exist or is not a directory: ${cwd}`);
    this.name = "InvalidCwdError";
  }
}

/**
 * Thrown when the child is killed for exceeding a timeout. Carries the bound and
 * WHICH cap fired: `"idle"` (no output for idleTimeoutMs — likely hung/unreachable)
 * or `"total"` (exceeded the total runtime cap). `kind` is additive and defaults
 * to `"total"`, so `new TimeoutError(msg, ms)` call sites are unchanged.
 */
export class TimeoutError extends Error {
  readonly code = "timeout";
  constructor(
    message: string,
    readonly timeoutMs: number,
    readonly kind: "idle" | "total" = "total",
  ) {
    super(message);
    this.name = "TimeoutError";
  }
}

/** Thrown when the child is killed for exceeding `maxOutputBytes`. Carries the cap. */
export class OutputLimitError extends Error {
  readonly code = "output_limit";
  constructor(
    message: string,
    readonly maxOutputBytes: number,
  ) {
    super(message);
    this.name = "OutputLimitError";
  }
}

/**
 * Thrown when the child is detected as stalled: it prints diagnostic reconnect
 * phrases on stderr (the adapter's `stallSignatures`) but never produces stdout,
 * and the attempt/strike counters corroborate that it will not recover. The
 * process group is killed; the rejection surfaces on `close` so the semaphore
 * permit is released only after the tree is actually gone.
 */
export class AgentStalledError extends Error {
  readonly code = "stream_stalled";
  constructor(
    message: string,
    readonly signature: string,
    readonly strikes: number,
  ) {
    super(message);
    this.name = "AgentStalledError";
  }
}

/**
 * Kill an entire process group. Children are spawned `detached`, making each the
 * leader of its own group, so `process.kill(-pid, …)` reaps the child and every
 * grandchild it forked. ESRCH (group already gone) is benign. On EPERM or any
 * other group-kill failure we fall back to killing just the child PID. The whole
 * kill path is best-effort: it never throws, so it can never mask the
 * timeout-or-output-limit error being surfaced to the caller.
 */
function killGroup(pid: number | undefined, signal: NodeJS.Signals, fallback: () => void): void {
  if (pid == null) return;
  try {
    process.kill(-pid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return;
    try {
      fallback();
    } catch {
      /* swallow: a failed fallback must not mask the original error */
    }
  }
}

/**
 * Live children spawned by this module. Children are `detached` (their own group
 * leaders), so if the server process dies without reaping them, their whole
 * process tree is orphaned and keeps running. We track every live child and, on
 * server shutdown, SIGKILL each group.
 *
 * Reaping uses the same POSIX `process.kill(-pid)` group kill as the rest of the
 * module. On a platform without process groups (Windows) that falls back to
 * killing only the direct child, so a grandchild there could still leak — a
 * pre-existing limitation of the codebase's POSIX-oriented kill strategy, not of
 * this reaper. The runtime target is POSIX (unix agent CLIs).
 */
const liveChildren = new Set<ChildProcess>();

/** SIGKILL a child's whole process group, falling back to the bare child. */
function killChildGroup(child: ChildProcess): void {
  killGroup(child.pid, "SIGKILL", () => child.kill("SIGKILL"));
}

/** Best-effort: kill every still-live child's process group. Never throws. */
export function reapAllChildren(): void {
  for (const child of liveChildren) {
    killChildGroup(child);
  }
}

// Install the shutdown reaper exactly once, lazily on first spawn (so importing
// this module has no global side effect). `exit` runs synchronously on any exit;
// the SIGINT/SIGTERM/SIGHUP handlers reap first, remove themselves, then re-raise
// the signal so the process still terminates with the default disposition.
let shutdownHandlersInstalled = false;
function installShutdownReaper(): void {
  if (shutdownHandlersInstalled) return;
  shutdownHandlersInstalled = true;
  process.once("exit", reapAllChildren);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    /* v8 ignore start -- the handler re-raises the signal, which would terminate
       the test runner; the reap it performs IS covered directly via
       reapAllChildren() in exec.test.ts. */
    const handler = (): void => {
      reapAllChildren();
      process.removeListener(sig, handler);
      process.kill(process.pid, sig);
    };
    /* v8 ignore stop */
    process.on(sig, handler);
  }
}

/**
 * FIFO async semaphore. `acquire` resolves to a release token that hands the
 * permit straight to the next waiter (never bumping the count while anyone is
 * queued) and is idempotent so a double release cannot leak an extra permit.
 *
 * The wait queue is bounded: when no permit is free and the queue is already at
 * `maxQueue()`, `acquire` rejects with `ServerBusyError` BEFORE enqueuing rather
 * than letting the backlog grow without limit. `maxQueue` is a thunk so the
 * bound is read per-acquire (keeps the class free of env reads and lets it be
 * overridden without reloading the module).
 */
class Semaphore {
  private permits: number;
  private readonly waiters: Array<() => void> = [];
  private readonly maxQueue: () => number;

  constructor(permits: number, maxQueue: () => number) {
    this.permits = permits;
    this.maxQueue = maxQueue;
  }

  async acquire(): Promise<() => void> {
    if (this.permits > 0) {
      this.permits -= 1;
    } else {
      if (this.waiters.length >= this.maxQueue()) {
        throw new ServerBusyError();
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.permits += 1;
    };
  }
}

const sem = new Semaphore(MAX_CONCURRENT_AGENTS, () => parseMaxQueue(process.env.MCP_MAX_QUEUE));

/** Run `fn` holding one semaphore slot; the slot is released on every exit path. */
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  const release = await sem.acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Single terminal cause. Replaces the old two-flag scheme (`killedForOutput` +
 * `timeoutCause`) so a cause recorded earlier can never be masked by a later
 * output-cap breach. `markTerminal` is idempotent — a second call is a no-op —
 * and it clears BOTH timers and kills the group in one shot. The `close`
 * handler rejects based on `terminalCause.kind`; we never reject from inside
 * the detector, because rejecting early would release the concurrency semaphore
 * permit BEFORE the process group is actually gone.
 */
type TerminalCause =
  | { kind: "idle" | "total"; windowMs: number }
  | { kind: "output"; maxOutputBytes: number }
  | { kind: "stall"; signature: string; strikes: number };

const runCommandInner: Exec = (binary, args, opts = {}) => {
  const timeoutMs = clampTimer(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const idleTimeoutMs = clampTimer(opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const stallSignatures = opts.stallSignatures ?? null;
  const stallAttemptLimit = opts.stallAttemptLimit ?? DEFAULT_STALL_ATTEMPT_LIMIT;
  const stallStrikeLimit = opts.stallStrikeLimit ?? DEFAULT_STALL_STRIKE_LIMIT;
  return new Promise<ExecResult>((resolve, reject) => {
    // Pre-flight the cwd so a missing directory is never mistaken for a missing
    // binary (spawn reports ENOENT for both). See InvalidCwdError.
    if (opts.cwd !== undefined && !isDirectory(opts.cwd)) {
      reject(new InvalidCwdError(opts.cwd));
      return;
    }
    // Build an explicit env only when there is something to strip OR overlay;
    // otherwise omit the option so the child inherits process.env verbatim
    // (unchanged behavior). Strip first, then overlay — an `env` override always
    // wins and is never removed by a later strip key.
    const stripEnvKeys = opts.stripEnvKeys;
    const envOverlay = opts.env;
    let childEnv: NodeJS.ProcessEnv | undefined;
    if ((stripEnvKeys && stripEnvKeys.length > 0) || envOverlay) {
      childEnv = { ...process.env };
      if (stripEnvKeys) for (const key of stripEnvKeys) delete childEnv[key];
      if (envOverlay) Object.assign(childEnv, envOverlay);
    }
    const child = spawn(binary, args, {
      cwd: opts.cwd,
      detached: true,
      stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      ...(childEnv ? { env: childEnv } : {}),
    });
    liveChildren.add(child);
    installShutdownReaper();
    const killTree = () => killChildGroup(child);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let outputBytes = 0;
    // Single terminal cause: first to fire wins, recorded exactly once by
    // markTerminal so a losing timer can never overwrite it or double-kill.
    let terminalCause: TerminalCause | undefined;
    let settled = false;

    // Stall detector state (only armed when stallSignatures is non-empty).
    let stallStrikes = 0;
    let stallMaxAttempt = 0;
    let stallNoAttemptStrikes = 0;
    let stallSignatureLast = "";
    // Rolling buffer: a data chunk may split a line mid-byte, so we keep the
    // trailing partial across chunks and only test complete lines.
    let stderrRemainder = "";
    // Only stdout bytes count as "productive" — stderr reconnect phrases are
    // diagnostic noise, not progress toward a model answer.
    let productiveStdoutBytes = 0;

    // The TOTAL timer bounds runtime and is NEVER reset. The IDLE timer is reset
    // on every accepted chunk. Both start after the semaphore slot is acquired,
    // so the caps bound the child's runtime, not time spent queued behind the cap.
    let idleTimer: NodeJS.Timeout;
    const totalTimer = setTimeout(
      () => markTerminal({ kind: "total", windowMs: timeoutMs }),
      timeoutMs,
    );

    const clearTimers = () => {
      clearTimeout(totalTimer);
      clearTimeout(idleTimer);
    };

    // Single guarded terminal path: first cause to fire wins, records the cause,
    // stops BOTH timers, then kills the tree. Idempotent — a second call (losing
    // timer, or a race with settle) is a no-op, so no double-kill / overwrite.
    function markTerminal(cause: TerminalCause): void {
      /* v8 ignore next -- unreachable: clearTimers() cancels the losing timer before it can fire, so markTerminal runs at most once (settled/terminalCause never true on entry) */
      if (settled || terminalCause) return;
      terminalCause = cause;
      clearTimers();
      killTree();
    }

    idleTimer = setTimeout(
      () => markTerminal({ kind: "idle", windowMs: idleTimeoutMs }),
      idleTimeoutMs,
    );

    if (opts.input !== undefined) {
      // Swallow EPIPE if the child exits before reading its stdin.
      child.stdin?.on("error", () => {});
      child.stdin?.write(opts.input);
      child.stdin?.end();
    }

    // Test a complete stderr line against the stall signatures. Returns the
    // matched signature text (already stripped/trimmed) or undefined.
    const testStallLine = (line: string): string | undefined => {
      if (!stallSignatures || stallSignatures.length === 0) return undefined;
      const stripped = stripAnsi(line).trim();
      if (stripped.length === 0) return undefined;
      for (const re of stallSignatures) {
        if (re.test(stripped)) return stripped;
      }
      return undefined;
    };

    // Parse an attempt number out of a stall line, e.g. "… (attempt 1)…" → 1.
    // Returns undefined when no attempt number is present.
    const parseAttempt = (line: string): number | undefined => {
      const m = /attempt\D{0,10}(\d+)/i.exec(line);
      return m ? Number(m[1]) : undefined;
    };

    const track = (chunk: Buffer, sink: Buffer[], isStdout: boolean) => {
      if (terminalCause) return;
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        // Stop accumulating and drop what we captured: memory must not keep
        // growing between the breach and the child actually dying. The fatal
        // breach chunk is NOT activity — it neither re-arms idle nor fires a
        // heartbeat right before the kill.
        markTerminal({ kind: "output", maxOutputBytes });
        stdoutChunks.length = 0;
        stderrChunks.length = 0;
        return;
      }

      if (isStdout) {
        sink.push(chunk);
        productiveStdoutBytes += chunk.length;
        // ACCEPTED stdout chunk: this counts as progress. Fire the (synchronous)
        // activity hook and reset the idle window from now.
        opts.onActivity?.();
        clearTimeout(idleTimer);
        idleTimer = setTimeout(
          () => markTerminal({ kind: "idle", windowMs: idleTimeoutMs }),
          idleTimeoutMs,
        );
        return;
      }

      // stderr path.
      if (stallSignatures && stallSignatures.length > 0) {
        // Append to the rolling buffer and split on newlines. Keep the trailing
        // partial so a line straddling two chunks is reassembled intact.
        stderrRemainder += chunk.toString("utf8");
        const lines = stderrRemainder.split("\n");
        // The last element is the partial (may be empty if chunk ended on \n).
        stderrRemainder = lines.pop() ?? "";
        let matchedInBatch = false;
        for (const line of lines) {
          const sig = testStallLine(line);
          if (sig === undefined) continue;
          matchedInBatch = true;
          stallStrikes += 1;
          stallSignatureLast = sig;
          const attempt = parseAttempt(sig);
          if (attempt !== undefined) {
            stallMaxAttempt = Math.max(stallMaxAttempt, attempt);
          } else {
            // Only attempt-less signatures feed the raw-strike fallback, so a
            // legitimate reconnect that keeps resetting to "attempt 1" cannot
            // masquerade as escalating failure.
            stallNoAttemptStrikes += 1;
          }
        }
        if (matchedInBatch) {
          // A stall line is NOT activity: sink the bytes but never re-arm idle.
          sink.push(chunk);
          if (
            productiveStdoutBytes === 0 &&
            (stallMaxAttempt >= stallAttemptLimit || stallNoAttemptStrikes >= stallStrikeLimit)
          ) {
            markTerminal({
              kind: "stall",
              signature: stallSignatureLast,
              strikes: stallStrikes,
            });
          }
          return;
        }
        // No stall line matched — treat as ordinary activity (existing behavior).
        sink.push(chunk);
        opts.onActivity?.();
        clearTimeout(idleTimer);
        idleTimer = setTimeout(
          () => markTerminal({ kind: "idle", windowMs: idleTimeoutMs }),
          idleTimeoutMs,
        );
        return;
      }

      // No stall signatures armed: stderr behaves like stdout for activity.
      sink.push(chunk);
      opts.onActivity?.();
      clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => markTerminal({ kind: "idle", windowMs: idleTimeoutMs }),
        idleTimeoutMs,
      );
    };

    child.stdout?.on("data", (chunk: Buffer) => track(chunk, stdoutChunks, true));
    child.stderr?.on("data", (chunk: Buffer) => track(chunk, stderrChunks, false));

    child.on("error", (err) => {
      clearTimers();
      liveChildren.delete(child);
      if (settled) return;
      settled = true;
      reject(
        new SpawnError(
          `Failed to start "${binary}": ${err.message}. Is it installed and on PATH?`,
          err,
        ),
      );
    });

    child.on("close", (code) => {
      clearTimers();
      liveChildren.delete(child);
      if (settled) return;
      settled = true;
      if (terminalCause) {
        if (terminalCause.kind === "output") {
          // Never echo the captured bytes back — only the limit that was breached.
          reject(
            new OutputLimitError(
              `"${binary}" exceeded output limit of ${terminalCause.maxOutputBytes} bytes`,
              terminalCause.maxOutputBytes,
            ),
          );
          return;
        }
        if (terminalCause.kind === "idle") {
          reject(
            new TimeoutError(
              `"${binary}" produced no output for ${terminalCause.windowMs}ms (idle) — it may be hung or its model/backend is unreachable`,
              terminalCause.windowMs,
              "idle",
            ),
          );
          return;
        }
        if (terminalCause.kind === "total") {
          reject(
            new TimeoutError(
              `"${binary}" timed out after ${timeoutMs}ms (total runtime cap)`,
              timeoutMs,
              "total",
            ),
          );
          return;
        }
        if (terminalCause.kind === "stall") {
          reject(
            new AgentStalledError(
              `"${binary}" stalled: detected diagnostic reconnect pattern — "${terminalCause.signature}" (strike ${terminalCause.strikes}). The agent cannot complete a run in this environment (common cause: TLS-intercepting proxy). Treat this agent as unavailable until the network path is fixed.`,
              terminalCause.signature,
              terminalCause.strikes,
            ),
          );
          return;
        }
        return;
      }
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode: code,
      });
    });
  });
};

export const runCommand: Exec = (binary, args, opts) =>
  withSlot(() => runCommandInner(binary, args, opts));
