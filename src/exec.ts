import { spawn } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export type Exec = (
  binary: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number; input?: string; maxOutputBytes?: number },
) => Promise<ExecResult>;

export const DEFAULT_TIMEOUT_MS = 300_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/** Positive finite integer only; NaN/0/negative/non-integer all fall back to 4. */
function parseConcurrency(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 4;
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

/** Thrown when the child is killed for exceeding `timeoutMs`. Carries the bound. */
export class TimeoutError extends Error {
  readonly code = "timeout";
  constructor(
    message: string,
    readonly timeoutMs: number,
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

const runCommandInner: Exec = (binary, args, opts = {}) => {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: opts.cwd,
      detached: true,
      stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const killTree = () => killGroup(child.pid, "SIGKILL", () => child.kill("SIGKILL"));

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let outputBytes = 0;
    let timedOut = false;
    let killedForOutput = false;
    let settled = false;

    // Timer starts here — after the semaphore slot is acquired — so timeoutMs
    // bounds the child's runtime, not the time spent queued behind the cap.
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);

    if (opts.input !== undefined) {
      // Swallow EPIPE if the child exits before reading its stdin.
      child.stdin?.on("error", () => {});
      child.stdin?.write(opts.input);
      child.stdin?.end();
    }

    const track = (chunk: Buffer, sink: Buffer[]) => {
      if (killedForOutput) return;
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        // Stop accumulating and drop what we captured: memory must not keep
        // growing between the breach and the child actually dying.
        killedForOutput = true;
        stdoutChunks.length = 0;
        stderrChunks.length = 0;
        clearTimeout(timer);
        killTree();
        return;
      }
      sink.push(chunk);
    };

    child.stdout?.on("data", (chunk: Buffer) => track(chunk, stdoutChunks));
    child.stderr?.on("data", (chunk: Buffer) => track(chunk, stderrChunks));

    child.on("error", (err) => {
      clearTimeout(timer);
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
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (killedForOutput) {
        // Never echo the captured bytes back — only the limit that was breached.
        reject(
          new OutputLimitError(
            `"${binary}" exceeded output limit of ${maxOutputBytes} bytes`,
            maxOutputBytes,
          ),
        );
        return;
      }
      if (timedOut) {
        reject(new TimeoutError(`"${binary}" timed out after ${timeoutMs}ms`, timeoutMs));
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
