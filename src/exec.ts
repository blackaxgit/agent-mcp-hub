import { spawn } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export type Exec = (
  binary: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number; input?: string },
) => Promise<ExecResult>;

export const DEFAULT_TIMEOUT_MS = 300_000;

export const runCommand: Exec = (binary, args, opts = {}) => {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: opts.cwd,
      stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    if (opts.input !== undefined) {
      // Swallow EPIPE if the child exits before reading its stdin.
      child.stdin?.on("error", () => {});
      child.stdin?.write(opts.input);
      child.stdin?.end();
    }

    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

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
