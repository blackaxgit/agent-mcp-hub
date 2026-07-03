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

/**
 * Cap on children spawned concurrently across the process. Parsed once at module
 * load; override via MCP_MAX_CONCURRENT_AGENTS.
 */
export const MAX_CONCURRENT_AGENTS = parseConcurrency(process.env.MCP_MAX_CONCURRENT_AGENTS);

/**
 * Kill an entire process group. Children are spawned `detached`, making each the
 * leader of its own group, so `process.kill(-pid, …)` reaps the child and every
 * grandchild it forked. ESRCH (group already gone) is benign. On EPERM or any
 * other group-kill failure we fall back to killing just the child PID. The whole
 * kill path is best-effort: it never throws, so it can never mask the
 * timeout-or-output-limit error being surfaced to the caller.
 */
function killGroup(
  pid: number | undefined,
  signal: NodeJS.Signals,
  fallback: () => void,
): void {
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
 */
class Semaphore {
  private permits: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<() => void> {
    if (this.permits > 0) {
      this.permits -= 1;
    } else {
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

const sem = new Semaphore(MAX_CONCURRENT_AGENTS);

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
        new Error(`Failed to start "${binary}": ${err.message}. Is it installed and on PATH?`),
      );
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (killedForOutput) {
        // Never echo the captured bytes back — only the limit that was breached.
        reject(new Error(`"${binary}" exceeded output limit of ${maxOutputBytes} bytes`));
        return;
      }
      if (timedOut) {
        reject(new Error(`"${binary}" timed out after ${timeoutMs}ms`));
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
