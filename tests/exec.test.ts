import { ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TIMEOUT_MS,
  MAX_CONCURRENT_AGENTS,
  ServerBusyError,
  TimeoutError,
  runCommand,
} from "../src/exec.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("runCommand", () => {
  it("captures stdout and exit code 0 on success", async () => {
    const r = await runCommand("node", ["-e", "console.log('hi')"]);
    expect(r.stdout.trim()).toBe("hi");
    expect(r.exitCode).toBe(0);
  });

  it("captures stderr and non-zero exit code on failure", async () => {
    const r = await runCommand("node", ["-e", "console.error('boom'); process.exit(3)"]);
    expect(r.stderr.trim()).toBe("boom");
    expect(r.exitCode).toBe(3);
  });

  it("pipes input to the child's stdin", async () => {
    const r = await runCommand("node", ["-e", "process.stdin.pipe(process.stdout)"], {
      input: "echo me",
    });
    expect(r.stdout).toBe("echo me");
    expect(r.exitCode).toBe(0);
  });

  it("rejects with an actionable error for a missing binary", async () => {
    await expect(runCommand("definitely-not-a-binary-xyz", [])).rejects.toThrow(
      /Is it installed and on PATH/,
    );
  });

  it("kills the process and rejects when the timeout is exceeded", async () => {
    await expect(
      runCommand("node", ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 200 }),
    ).rejects.toThrow(/timed out after 200ms/);
  });

  it("rejects timeout with a typed TimeoutError carrying timeoutMs", async () => {
    const err = await runCommand("node", ["-e", "setTimeout(() => {}, 10000)"], {
      timeoutMs: 200,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as TimeoutError).timeoutMs).toBe(200);
  });

  it("defaults the timeout to 300000ms", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(300_000);
  });
});

describe("MAX_CONCURRENT_AGENTS env parsing", () => {
  // parseConcurrency runs once at module load off MCP_MAX_CONCURRENT_AGENTS, so
  // to exercise both ternary arms we re-import the module with the env var set.
  // The static import at the top already covered the unset → NaN → fallback arm.
  const reimport = async (value: string | undefined) => {
    const prev = process.env.MCP_MAX_CONCURRENT_AGENTS;
    if (value === undefined) delete process.env.MCP_MAX_CONCURRENT_AGENTS;
    else process.env.MCP_MAX_CONCURRENT_AGENTS = value;
    vi.resetModules();
    try {
      const mod = await import("../src/exec.js");
      return mod.MAX_CONCURRENT_AGENTS;
    } finally {
      if (prev === undefined) delete process.env.MCP_MAX_CONCURRENT_AGENTS;
      else process.env.MCP_MAX_CONCURRENT_AGENTS = prev;
      vi.resetModules();
    }
  };

  it("uses a valid positive-integer override", async () => {
    // Positive-integer arm of `Number.isInteger(n) && n > 0 ? n : 4`.
    expect(await reimport("7")).toBe(7);
  });

  it.each([
    ["0", "not positive"],
    ["-1", "negative"],
    ["abc", "NaN"],
    ["2.5", "non-integer"],
    ["", "empty → Number('') is 0"],
  ])("falls back to 4 for %j (%s)", async (value) => {
    // Fallback arm: every non-positive-integer input collapses to the default 4.
    expect(await reimport(value)).toBe(4);
  });
});

describe("runCommand process-group tree kill", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "exec-tree-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("group-kills a grandchild that outlives the timed-out child", async () => {
    const marker = join(workDir, "grandchild.log");
    // The child spawns a grandchild (same process group) that keeps appending to
    // a file. Killing only the child's PID would orphan the grandchild alive; a
    // process-group kill must reap it too.
    const childScript =
      "const {spawn}=require('node:child_process');" +
      "spawn(process.execPath,['-e'," +
      "\"const fs=require('node:fs');setInterval(()=>{try{fs.appendFileSync(process.argv[1],'x')}catch(e){}},50)\"," +
      "process.argv[1]],{stdio:'ignore'});" +
      "setTimeout(()=>{},10000);";

    await expect(
      runCommand("node", ["-e", childScript, marker], { timeoutMs: 300 }),
    ).rejects.toThrow(/timed out after 300ms/);

    // Let any in-flight write settle, then confirm the grandchild stopped growing it.
    await delay(300);
    const sizeAfterKill = statSync(marker).size;
    await delay(600);
    const sizeLater = statSync(marker).size;
    expect(sizeLater).toBe(sizeAfterKill);
  });
});

describe("runCommand killGroup failure handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // A short-lived child that outlives its own timeout: when the group-kill is
  // sabotaged the child self-exits, so `close` still fires and the reject path
  // runs deterministically instead of hanging.
  const selfExiting = ["-e", "setTimeout(() => {}, 500)"];

  // Force only the process-GROUP kill (negative pid) to throw `code`; positive-pid
  // signals (Node internals, unrelated children) pass straight through. Returns a
  // counter of how many group-kill attempts were sabotaged.
  const sabotageGroupKill = (code: string) => {
    const realKill = process.kill.bind(process);
    const counter = { negativePidKills: 0 };
    vi.spyOn(process, "kill").mockImplementation((pid: number, signal?: string | number) => {
      if (pid < 0) {
        counter.negativePidKills += 1;
        throw Object.assign(new Error(code), { code });
      }
      return realKill(pid, signal as NodeJS.Signals);
    });
    return counter;
  };

  it("returns early on ESRCH group-kill without ever invoking the fallback", async () => {
    // Group already gone → process.kill(-pid) throws ESRCH. killGroup must treat
    // it as benign, take the early return, and NEVER touch the fallback path.
    const counter = sabotageGroupKill("ESRCH");
    const childKill = vi.spyOn(ChildProcess.prototype, "kill");

    const err = await runCommand("node", selfExiting, { timeoutMs: 100 }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as TimeoutError).message).toMatch(/timed out after 100ms/);
    expect(counter.negativePidKills).toBeGreaterThan(0);
    // ESRCH short-circuits before the single-PID fallback.
    expect(childKill).not.toHaveBeenCalled();
  });

  it("falls back to a single-PID kill on a non-ESRCH group-kill failure", async () => {
    // EPERM (or anything non-ESRCH) → killGroup must run the fallback, which is
    // child.kill on just the child PID. Let that real kill go through.
    const realChildKill = ChildProcess.prototype.kill;
    const counter = sabotageGroupKill("EPERM");
    const childKill = vi.spyOn(ChildProcess.prototype, "kill").mockImplementation(function (
      this: ChildProcess,
      signal?: number | NodeJS.Signals,
    ) {
      return realChildKill.call(this, signal);
    });

    const err = await runCommand("node", selfExiting, { timeoutMs: 100 }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as TimeoutError).message).toMatch(/timed out after 100ms/);
    expect(counter.negativePidKills).toBeGreaterThan(0);
    // The fallback fired: child.kill("SIGKILL") reaped the child by its own PID.
    expect(childKill).toHaveBeenCalledWith("SIGKILL");
  });

  it("swallows a throwing fallback and still surfaces the TimeoutError", async () => {
    // Worst case: group-kill fails non-ESRCH AND the single-PID fallback itself
    // throws. killGroup must swallow both so the caller sees the original
    // TimeoutError, never a kill error. The child self-exits since no kill lands.
    const counter = sabotageGroupKill("EPERM");
    const childKill = vi.spyOn(ChildProcess.prototype, "kill").mockImplementation(() => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    });

    const err = await runCommand("node", selfExiting, { timeoutMs: 100 }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as TimeoutError).message).toMatch(/timed out after 100ms/);
    expect(counter.negativePidKills).toBeGreaterThan(0);
    expect(childKill).toHaveBeenCalledWith("SIGKILL");
  });
});

describe("runCommand output cap", () => {
  it("kills the child and rejects when output exceeds maxOutputBytes", async () => {
    const flood =
      "const b=Buffer.alloc(2048,120);" +
      "function w(){if(process.stdout.write(b))setImmediate(w);else process.stdout.once('drain',w);}" +
      "w();";
    await expect(runCommand("node", ["-e", flood], { maxOutputBytes: 1024 })).rejects.toThrow(
      /exceeded output limit of 1024 bytes/,
    );
  });

  it("issues the output-limit kill once despite many post-breach chunks", async () => {
    // A single large synchronous write leaves the pipe full, so the parent drains
    // it as many `data` events AFTER the breach flips `killedForOutput`. Those
    // later events must hit the early return (`if (killedForOutput) return;`) and
    // NOT re-run the kill: the group-kill fires exactly once, not once per chunk.
    const realKill = process.kill.bind(process);
    let groupKills = 0;
    vi.spyOn(process, "kill").mockImplementation((pid: number, signal?: string | number) => {
      if (pid < 0) groupKills += 1;
      return realKill(pid, signal as NodeJS.Signals);
    });

    const flood = "process.stdout.write(Buffer.alloc(1<<20, 120));setTimeout(()=>{},2000);";
    await expect(runCommand("node", ["-e", flood], { maxOutputBytes: 1024 })).rejects.toThrow(
      /exceeded output limit of 1024 bytes/,
    );

    // One breach → one group kill. Removing the `killedForOutput` guard would
    // re-enter the limit branch on every drained chunk and kill repeatedly.
    expect(groupKills).toBe(1);
    vi.restoreAllMocks();
  });

  it("does not echo captured bytes in the limit error", async () => {
    const flood =
      "const b=Buffer.alloc(2048,83);" + // 'S' bytes
      "function w(){if(process.stdout.write(b))setImmediate(w);else process.stdout.once('drain',w);}" +
      "w();";
    await runCommand("node", ["-e", flood], { maxOutputBytes: 1024 }).then(
      () => {
        throw new Error("expected rejection");
      },
      (err: Error) => {
        expect(err.message).not.toContain("SSSS");
      },
    );
  });
});

describe("runCommand concurrency semaphore", () => {
  let markersDir: string;
  let resultsFile: string;

  beforeEach(() => {
    markersDir = mkdtempSync(join(tmpdir(), "exec-sem-"));
    resultsFile = join(mkdtempSync(join(tmpdir(), "exec-res-")), "results");
  });

  afterEach(() => {
    rmSync(markersDir, { recursive: true, force: true });
    rmSync(join(resultsFile, ".."), { recursive: true, force: true });
  });

  it("never runs more than MAX_CONCURRENT_AGENTS children at once", async () => {
    // Each child registers a marker file, records how many markers currently
    // exist (its observed concurrency), sleeps, then removes its marker. With the
    // semaphore enforced, no child can ever observe more than the cap.
    const script =
      "const fs=require('node:fs');" +
      "const dir=process.argv[1],results=process.argv[2],id=process.argv[3];" +
      "const marker=dir+'/'+id;" +
      "fs.writeFileSync(marker,'x');" +
      "fs.appendFileSync(results,fs.readdirSync(dir).length+'\\n');" +
      "setTimeout(()=>{try{fs.unlinkSync(marker)}catch(e){}},300);";

    const runs = [];
    for (let i = 0; i < MAX_CONCURRENT_AGENTS * 2; i++) {
      runs.push(runCommand("node", ["-e", script, markersDir, resultsFile, String(i)]));
    }
    await Promise.all(runs);

    const observed = readFileSync(resultsFile, "utf8").trim().split("\n").map(Number);
    expect(observed.length).toBe(MAX_CONCURRENT_AGENTS * 2);
    expect(Math.max(...observed)).toBeLessThanOrEqual(MAX_CONCURRENT_AGENTS);
  });

  it("rejects with ServerBusyError when the queue is full", async () => {
    // MCP_MAX_QUEUE is read per-acquire, so setting it to "0" makes the queue
    // reject the instant every permit is busy — no waiting, deterministic.
    const prev = process.env.MCP_MAX_QUEUE;
    process.env.MCP_MAX_QUEUE = "0";
    try {
      // Saturate every permit with slow, still-running children.
      const inFlight = Array.from({ length: MAX_CONCURRENT_AGENTS }, () =>
        runCommand("node", ["-e", "setTimeout(() => {}, 1500)"]),
      );
      // Give the acquires above a tick to take all permits before we overflow.
      await delay(50);

      // With permits exhausted and maxQueue 0, the next acquire sheds load.
      await expect(runCommand("node", ["-e", "0"])).rejects.toBeInstanceOf(ServerBusyError);
      await expect(runCommand("node", ["-e", "0"])).rejects.toMatchObject({
        code: "SERVER_BUSY",
      });

      // The in-flight children were never disturbed and still resolve cleanly.
      const results = await Promise.all(inFlight);
      for (const r of results) expect(r.exitCode).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.MCP_MAX_QUEUE;
      else process.env.MCP_MAX_QUEUE = prev;
    }
  });
});
