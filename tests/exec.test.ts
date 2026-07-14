import { ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentStalledError,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  InvalidCwdError,
  MAX_CONCURRENT_AGENTS,
  MAX_TIMEOUT_MS,
  OutputLimitError,
  ServerBusyError,
  TimeoutError,
  clampTimer,
  reapAllChildren,
  runCommand,
} from "../src/exec.js";
import { cursorAdapter } from "../src/adapters/cursor.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("reapAllChildren (P2-F: no orphaned children on shutdown)", () => {
  it("is a safe no-op when nothing is live", () => {
    expect(() => reapAllChildren()).not.toThrow();
  });

  it("SIGKILLs a still-live child's process group", async () => {
    // A long-lived child that would otherwise be orphaned on server shutdown.
    const pending = runCommand(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
    await delay(300); // let it spawn and register in liveChildren
    reapAllChildren();
    const result = await pending;
    // Killed by signal → no clean exit code.
    expect(result.exitCode).toBeNull();
  });
});

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

  it("kills the process and rejects when the total timeout is exceeded", async () => {
    // idleTimeoutMs > timeoutMs so the TOTAL cap (not idle) is the one that fires.
    const err = await runCommand("node", ["-e", "setTimeout(() => {}, 10000)"], {
      timeoutMs: 200,
      idleTimeoutMs: 5000,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as TimeoutError).message).toMatch(/timed out after 200ms/);
    expect((err as TimeoutError).kind).toBe("total");
  });

  it("rejects total timeout with a typed TimeoutError carrying timeoutMs", async () => {
    const err = await runCommand("node", ["-e", "setTimeout(() => {}, 10000)"], {
      timeoutMs: 200,
      idleTimeoutMs: 5000,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as TimeoutError).timeoutMs).toBe(200);
    expect((err as TimeoutError).kind).toBe("total");
  });

  it("defaults the total timeout to 1800000ms", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(1_800_000);
  });

  it("defaults the idle timeout to 300000ms", () => {
    expect(DEFAULT_IDLE_TIMEOUT_MS).toBe(300_000);
  });
});

describe("clampTimer (P2-E)", () => {
  it("caps the 24h ceiling and pins MAX_TIMEOUT_MS at 24h", () => {
    expect(MAX_TIMEOUT_MS).toBe(24 * 60 * 60 * 1000);
    // An enormous timer must clamp DOWN to the ceiling — an unclamped delay past
    // 2^31-1 ms truncates and fires setTimeout immediately, killing the child.
    expect(clampTimer(Number.MAX_SAFE_INTEGER)).toBe(MAX_TIMEOUT_MS);
    expect(clampTimer(MAX_TIMEOUT_MS + 1)).toBe(MAX_TIMEOUT_MS);
  });

  it("clamps non-positive values up to the 1ms floor", () => {
    expect(clampTimer(0)).toBe(1);
    expect(clampTimer(-5)).toBe(1);
  });

  it("floors fractional values toward the nearest integer", () => {
    expect(clampTimer(1.9)).toBe(1);
    expect(clampTimer(5000.7)).toBe(5000);
  });

  it("maps non-finite input to the ceiling (never immediate-fire)", () => {
    expect(clampTimer(Infinity)).toBe(MAX_TIMEOUT_MS);
    expect(clampTimer(Number.NaN)).toBe(MAX_TIMEOUT_MS);
  });

  it("passes an in-range value through unchanged", () => {
    expect(clampTimer(5000)).toBe(5000);
  });
});

describe("runCommand idle timeout", () => {
  it("A1: kills a silent child at the idle window with kind 'idle'", async () => {
    // Small idle window, LARGE total cap: the kill must come from the IDLE timer,
    // not the total. Elapsed well under the 10s total (but above the 150ms idle)
    // proves idle fired — a total-driven kill could not land this fast.
    const start = Date.now();
    const err = await runCommand("node", ["-e", "setTimeout(()=>{},10000)"], {
      idleTimeoutMs: 150,
      timeoutMs: 10_000,
    }).catch((e: unknown) => e);
    const elapsed = Date.now() - start;
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as TimeoutError).kind).toBe("idle");
    expect((err as TimeoutError).timeoutMs).toBe(150);
    expect((err as TimeoutError).message).toMatch(/no output/);
    // Comfortably under the 10s total cap — proves idle, not total, did the kill.
    expect(elapsed).toBeLessThan(2000);
  });

  it("A2: a periodically-printing child resets the idle timer and survives", async () => {
    // Prints every ~40ms for ~400ms; idle window (150ms) is ≥3× the interval, so
    // each line re-arms idle and the child is NOT killed — it exits 0 on its own.
    const script =
      "let n=0;const t=setInterval(()=>{console.log(n++);if(n>9){clearInterval(t)}},40);";
    const r = await runCommand("node", ["-e", script], {
      idleTimeoutMs: 150,
      timeoutMs: 30_000,
    });
    expect(r.exitCode).toBe(0);
  });

  it("A3: total cap fires before idle for a continuously-printing child", async () => {
    // Small total cap, LARGE idle window (10s) that the child never approaches —
    // it prints every 10ms so the idle timer is perpetually re-armed and can never
    // fire. The kill at well under 2s therefore can only be the TOTAL cap.
    const start = Date.now();
    const err = await runCommand(
      "node",
      ["-e", "setInterval(()=>console.log('x'),10);setTimeout(()=>{},30000);"],
      { timeoutMs: 300, idleTimeoutMs: 10_000 },
    ).catch((e: unknown) => e);
    const elapsed = Date.now() - start;
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as TimeoutError).kind).toBe("total");
    expect((err as TimeoutError).timeoutMs).toBe(300);
    expect((err as TimeoutError).message).toMatch(/timed out/);
    // Idle is 10s and never idle anyway — sub-2s can only be the total cap.
    expect(elapsed).toBeLessThan(2000);
  });

  it("A4: with idle === total both timers race but reject exactly once", async () => {
    // Silent child, idleTimeoutMs === timeoutMs (both small + equal): the total
    // and idle timers are scheduled for the same tick, so both callbacks are due
    // together. markTimeout()'s guard must let only the FIRST win — a single
    // TimeoutError, one kill, no double-reject and no unhandled rejection. The
    // test simply completing (Promise settles once, process does not crash) is the
    // proof; kind may be "idle" or "total" depending on timer ordering.
    let rejections = 0;
    const err = await runCommand("node", ["-e", "setTimeout(()=>{},10000)"], {
      idleTimeoutMs: 120,
      timeoutMs: 120,
    }).then(
      () => {
        throw new Error("expected the racing timers to reject");
      },
      (e: unknown) => {
        rejections += 1;
        return e;
      },
    );
    expect(rejections).toBe(1);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(["idle", "total"]).toContain((err as TimeoutError).kind);
    // Give any losing timer its chance to (wrongly) fire a second time; a stray
    // reject/kill would surface as an unhandled rejection and fail the run.
    await delay(300);
  });
});

describe("runCommand onActivity", () => {
  it("A5: fires ≥1 for a printing child and is absent-safe", async () => {
    let calls = 0;
    const r = await runCommand("node", ["-e", "console.log('a');console.log('b')"], {
      onActivity: () => {
        calls += 1;
      },
    });
    expect(r.exitCode).toBe(0);
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  it("A5: does not fire for a silent child killed by idle", async () => {
    let calls = 0;
    await runCommand("node", ["-e", "setTimeout(()=>{},5000)"], {
      idleTimeoutMs: 100,
      timeoutMs: 30_000,
      onActivity: () => {
        calls += 1;
      },
    }).catch(() => {});
    expect(calls).toBe(0);
  });

  it("A5: an absent onActivity callback is a no-op", async () => {
    // No onActivity passed — a printing child must not crash the tracker.
    const r = await runCommand("node", ["-e", "console.log('hi')"]);
    expect(r.stdout.trim()).toBe("hi");
    expect(r.exitCode).toBe(0);
  });
});

describe("TimeoutError back-compat", () => {
  it("A11: keeps code/name/timeoutMs/instanceof and defaults kind to 'total'", () => {
    const err = new TimeoutError("x", 50);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err.code).toBe("timeout");
    expect(err.name).toBe("TimeoutError");
    expect(err.timeoutMs).toBe(50);
    expect(err.kind).toBe("total");
  });

  it("A11: accepts an explicit idle kind", () => {
    expect(new TimeoutError("x", 50, "idle").kind).toBe("idle");
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

describe("timeout default env parsing", () => {
  // DEFAULT_TIMEOUT_MS / DEFAULT_IDLE_TIMEOUT_MS are parsed once at module load
  // via the shared positive-int helper, so re-import the module with the env set
  // to exercise both the override and the invalid-→-default arms.
  const reimport = async (env: {
    total?: string | undefined;
    idle?: string | undefined;
  }): Promise<{ total: number; idle: number }> => {
    const prevTotal = process.env.MCP_AGENT_TIMEOUT_MS;
    const prevIdle = process.env.MCP_AGENT_IDLE_TIMEOUT_MS;
    const set = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    set("MCP_AGENT_TIMEOUT_MS", env.total);
    set("MCP_AGENT_IDLE_TIMEOUT_MS", env.idle);
    vi.resetModules();
    try {
      const mod = await import("../src/exec.js");
      return { total: mod.DEFAULT_TIMEOUT_MS, idle: mod.DEFAULT_IDLE_TIMEOUT_MS };
    } finally {
      set("MCP_AGENT_TIMEOUT_MS", prevTotal);
      set("MCP_AGENT_IDLE_TIMEOUT_MS", prevIdle);
      vi.resetModules();
    }
  };

  it("uses valid positive-integer overrides", async () => {
    expect(await reimport({ total: "600000", idle: "45000" })).toEqual({
      total: 600_000,
      idle: 45_000,
    });
  });

  it("falls back to the raised total default and 300000 idle for invalid env", async () => {
    // Invalid values (non-integer / negative) collapse to the built-in defaults.
    expect(await reimport({ total: "abc", idle: "-5" })).toEqual({
      total: 1_800_000,
      idle: 300_000,
    });
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

    const err = await runCommand("node", ["-e", childScript, marker], {
      timeoutMs: 300,
      idleTimeoutMs: 5000,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as TimeoutError).message).toMatch(/timed out after 300ms/);
    expect((err as TimeoutError).kind).toBe("total");

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

    const err = await runCommand("node", selfExiting, {
      timeoutMs: 100,
      idleTimeoutMs: 5000,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as TimeoutError).message).toMatch(/timed out after 100ms/);
    expect((err as TimeoutError).kind).toBe("total");
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

    const err = await runCommand("node", selfExiting, {
      timeoutMs: 100,
      idleTimeoutMs: 5000,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as TimeoutError).message).toMatch(/timed out after 100ms/);
    expect((err as TimeoutError).kind).toBe("total");
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

    const err = await runCommand("node", selfExiting, {
      timeoutMs: 100,
      idleTimeoutMs: 5000,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as TimeoutError).message).toMatch(/timed out after 100ms/);
    expect((err as TimeoutError).kind).toBe("total");
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

  it("clears the timers on the output-cap path so neither timer double-fires", async () => {
    // The child floods stdout past a tiny cap while BOTH timeout windows are small
    // enough that they WOULD otherwise fire. The output-cap breach must call
    // clearTimers() and win: the call rejects with OutputLimitError (never a
    // TimeoutError), exactly once, and no stray timer fires afterward (a leaked
    // idle/total timer would markTimeout → double-kill → unhandled rejection).
    let rejections = 0;
    const flood =
      "const b=Buffer.alloc(4096,120);" +
      "function w(){if(process.stdout.write(b))setImmediate(w);else process.stdout.once('drain',w);}" +
      "w();";
    const err = await runCommand("node", ["-e", flood], {
      maxOutputBytes: 10,
      idleTimeoutMs: 100,
      timeoutMs: 100,
    }).then(
      () => {
        throw new Error("expected the output cap to reject");
      },
      (e: unknown) => {
        rejections += 1;
        return e;
      },
    );
    expect(rejections).toBe(1);
    expect(err).toBeInstanceOf(OutputLimitError);
    expect(err).not.toBeInstanceOf(TimeoutError);
    expect((err as OutputLimitError).maxOutputBytes).toBe(10);
    // Past both timeout windows: a leaked timer would have double-fired by now.
    await delay(300);
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

describe("runCommand — stripEnvKeys least-privilege child env", () => {
  const printEnv =
    "process.stdout.write(JSON.stringify({" +
    "a:process.env.SECRET_A ?? null,b:process.env.SECRET_B ?? null}))";

  let prevA: string | undefined;
  let prevB: string | undefined;

  beforeEach(() => {
    prevA = process.env.SECRET_A;
    prevB = process.env.SECRET_B;
    process.env.SECRET_A = "sibling-agent-key";
    process.env.SECRET_B = "keep-me";
  });

  afterEach(() => {
    if (prevA === undefined) delete process.env.SECRET_A;
    else process.env.SECRET_A = prevA;
    if (prevB === undefined) delete process.env.SECRET_B;
    else process.env.SECRET_B = prevB;
  });

  it("strips only the listed keys; every other parent var is preserved", async () => {
    const r = await runCommand(process.execPath, ["-e", printEnv], {
      stripEnvKeys: ["SECRET_A"],
    });
    const seen = JSON.parse(r.stdout) as { a: string | null; b: string | null };
    // The sibling agent's secret is gone from the child…
    expect(seen.a).toBeNull();
    // …while an unrelated inherited var (PATH-like) survives intact.
    expect(seen.b).toBe("keep-me");
    expect(r.exitCode).toBe(0);
  });

  it("without stripEnvKeys the child inherits the full parent env (unchanged behavior)", async () => {
    const r = await runCommand(process.execPath, ["-e", printEnv]);
    const seen = JSON.parse(r.stdout) as { a: string | null; b: string | null };
    expect(seen.a).toBe("sibling-agent-key");
    expect(seen.b).toBe("keep-me");
    expect(r.exitCode).toBe(0);
  });

  it("an empty stripEnvKeys array leaves the env untouched", async () => {
    const r = await runCommand(process.execPath, ["-e", printEnv], { stripEnvKeys: [] });
    const seen = JSON.parse(r.stdout) as { a: string | null; b: string | null };
    expect(seen.a).toBe("sibling-agent-key");
    expect(seen.b).toBe("keep-me");
  });
});

describe("runCommand — env overlay (P2-E)", () => {
  it("sets an extra env var on the child that was not in the parent env", async () => {
    // The var is absent from process.env, so seeing it in the child proves it came
    // from the overlay, not inheritance.
    expect(process.env.MCPHUB_TEST_OVERLAY).toBeUndefined();
    const r = await runCommand(
      process.execPath,
      ["-e", "process.stdout.write(process.env.MCPHUB_TEST_OVERLAY ?? 'MISSING')"],
      { env: { MCPHUB_TEST_OVERLAY: "set-by-overlay" } },
    );
    expect(r.stdout).toBe("set-by-overlay");
    expect(r.exitCode).toBe(0);
  });

  it("applies overlay AFTER strip: strips one key and overlays a different one", async () => {
    const prev = process.env.MCPHUB_TEST_STRIP_ME;
    process.env.MCPHUB_TEST_STRIP_ME = "should-be-stripped";
    try {
      const script =
        "process.stdout.write(JSON.stringify({" +
        "stripped:process.env.MCPHUB_TEST_STRIP_ME ?? null," +
        "overlaid:process.env.MCPHUB_TEST_OVERLAY2 ?? null}))";
      const r = await runCommand(process.execPath, ["-e", script], {
        stripEnvKeys: ["MCPHUB_TEST_STRIP_ME"],
        env: { MCPHUB_TEST_OVERLAY2: "added" },
      });
      const seen = JSON.parse(r.stdout) as { stripped: string | null; overlaid: string | null };
      expect(seen.stripped).toBeNull();
      expect(seen.overlaid).toBe("added");
      expect(r.exitCode).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.MCPHUB_TEST_STRIP_ME;
      else process.env.MCPHUB_TEST_STRIP_ME = prev;
    }
  });

  it("an overlay override WINS over a strip key of the same name", async () => {
    // Same key stripped AND overlaid: overlay is applied last, so the child sees
    // the overlay value, never the stripped-then-restored parent value.
    const prev = process.env.MCPHUB_TEST_CONFLICT;
    process.env.MCPHUB_TEST_CONFLICT = "parent-value";
    try {
      const r = await runCommand(
        process.execPath,
        ["-e", "process.stdout.write(process.env.MCPHUB_TEST_CONFLICT ?? 'MISSING')"],
        { stripEnvKeys: ["MCPHUB_TEST_CONFLICT"], env: { MCPHUB_TEST_CONFLICT: "overlay-wins" } },
      );
      expect(r.stdout).toBe("overlay-wins");
    } finally {
      if (prev === undefined) delete process.env.MCPHUB_TEST_CONFLICT;
      else process.env.MCPHUB_TEST_CONFLICT = prev;
    }
  });
});

describe("runCommand — cwd preflight", () => {
  it("rejects with InvalidCwdError when cwd does not exist, without spawning", async () => {
    const missing = join(tmpdir(), "agent-mcp-hub-no-such-dir-xyz");
    await expect(
      runCommand(process.execPath, ["-e", "0"], { cwd: missing }),
    ).rejects.toBeInstanceOf(InvalidCwdError);
  });

  it("rejects when cwd exists but is a file, not a directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-mcp-hub-cwd-"));
    const file = join(dir, "a-file");
    writeFileSync(file, "x");
    try {
      await expect(runCommand(process.execPath, ["-e", "0"], { cwd: file })).rejects.toBeInstanceOf(
        InvalidCwdError,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("carries the offending path on the error", async () => {
    const missing = join(tmpdir(), "agent-mcp-hub-no-such-dir-xyz");
    await expect(runCommand(process.execPath, ["-e", "0"], { cwd: missing })).rejects.toMatchObject(
      {
        cwd: missing,
        code: "invalid_cwd",
      },
    );
  });

  it("still runs normally when cwd is a real directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-mcp-hub-cwd-"));
    try {
      const r = await runCommand(process.execPath, ["-e", "process.stdout.write(process.cwd())"], {
        cwd: dir,
      });
      expect(r.exitCode).toBe(0);
      expect(statSync(r.stdout).isDirectory()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Fake child that emits stall-signature lines on stderr and nothing on stdout.
 * `cycle` controls how many full reconnect cycles to emit (each cycle = one
 * "Connection lost … (attempt N)…" + one "Retry attempt N…" line). After the
 * cycles the child sleeps forever so the idle cap would fire if the stall
 * detector did not kill it first.
 */
const stallChildScript = (cycle: number) =>
  "const {stderr}=process;" +
  `for(let i=1;i<=${cycle};i++){` +
  "stderr.write(`Connection lost, reconnecting to https://agentn.global.api5.cursor.sh (attempt ${i})...\\n`);" +
  "stderr.write(`Retry attempt ${i}...\\n`);" +
  "}" +
  "setTimeout(()=>{},30000);";

/**
 * Fake child that emits stall lines on stderr AND productive lines on stdout.
 * `stallCycles` = how many reconnect cycles to emit; `stdoutLines` = how many
 * stdout lines to emit before the stall lines begin.
 */
const stallWithStdoutScript = (stallCycles: number, stdoutLines: number) => {
  const parts: string[] = [];
  for (let i = 0; i < stdoutLines; i++) {
    parts.push(`console.log('stdout-line-${i}');`);
  }
  parts.push(stallChildScript(stallCycles));
  return parts.join("");
};

describe("runCommand stall detector", () => {
  const stallSig = [/^connection lost, reconnecting to \S+ \(attempt \d+\)\.*$/i];

  it("S1: two reconnect cycles on stderr, no stdout -> AgentStalledError fast", async () => {
    const start = Date.now();
    const err = await runCommand(process.execPath, ["-e", stallChildScript(2)], {
      idleTimeoutMs: 60_000,
      timeoutMs: 60_000,
      stallSignatures: stallSig,
    }).catch((e: unknown) => e);
    const elapsed = Date.now() - start;
    expect(err).toBeInstanceOf(AgentStalledError);
    expect((err as AgentStalledError).code).toBe("stream_stalled");
    expect((err as AgentStalledError).signature).toMatch(/Connection lost/);
    expect((err as AgentStalledError).strikes).toBeGreaterThanOrEqual(2);
    // Far under both caps — proves the stall detector fired, not a timeout.
    expect(elapsed).toBeLessThan(5_000);
  });

  it("S2: CONTROL — same chatty child, NO stallSignatures -> runs to total cap", async () => {
    // Without stallSignatures the child's stderr chatter is just activity; the
    // idle timer keeps resetting and the child runs until the total cap.
    const err = await runCommand(process.execPath, ["-e", stallChildScript(2)], {
      idleTimeoutMs: 60_000,
      timeoutMs: 400,
      // stallSignatures intentionally omitted.
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as TimeoutError).kind).toBe("total");
  });

  it("S3: CONTROL — silent child -> still TimeoutError kind:'idle'", async () => {
    const err = await runCommand(process.execPath, ["-e", "setTimeout(()=>{},5000)"], {
      idleTimeoutMs: 150,
      timeoutMs: 10_000,
      stallSignatures: stallSig,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as TimeoutError).kind).toBe("idle");
  });

  it("S4: signature chatter but stdout produced first -> NOT AgentStalledError; idle fires", async () => {
    // productiveStdoutBytes > 0 suppresses the stall abort even when strikes accumulate.
    const err = await runCommand(process.execPath, ["-e", stallWithStdoutScript(3, 2)], {
      idleTimeoutMs: 150,
      timeoutMs: 60_000,
      stallSignatures: stallSig,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as TimeoutError).kind).toBe("idle");
    expect((err as TimeoutError).message).toMatch(/no output/);
  });

  it("S5: exactly ONE reconnect cycle (attempt 1), then silence -> NOT AgentStalledError; idle fires", async () => {
    // A single legitimate reconnect cycle must survive: attempt 1 never reaches
    // stallAttemptLimit (2), and 2 strikes (connection-lost + retry) is below
    // stallStrikeLimit (4). The idle timer eventually kills the silent child.
    const start = Date.now();
    const err = await runCommand(process.execPath, ["-e", stallChildScript(1)], {
      idleTimeoutMs: 200,
      timeoutMs: 30_000,
      stallSignatures: stallSig,
    }).catch((e: unknown) => e);
    const elapsed = Date.now() - start;
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as TimeoutError).kind).toBe("idle");
    // Above the 200ms idle window but far under the 30s total cap.
    expect(elapsed).toBeGreaterThan(150);
    expect(elapsed).toBeLessThan(5_000);
  });

  it("S6: the phrase arrives on STDOUT, not stderr -> NOT AgentStalledError", async () => {
    // The detector matches stderr ONLY. A model that quotes the phrase in its
    // answer on stdout must never trip the stall detector. The child prints the
    // phrase to stdout and then keeps printing to stay alive past the idle cap,
    // then exits cleanly so the run resolves with exitCode 0.
    const script =
      "console.log('Connection lost, reconnecting to https://example.com (attempt 1)...');" +
      "let n=0; const iv=setInterval(()=>{ if(++n>5){ clearInterval(iv); process.exit(0);} console.log('keep-alive'); }, 20);";
    const r = await runCommand(process.execPath, ["-e", script], {
      idleTimeoutMs: 200,
      timeoutMs: 60_000,
      stallSignatures: stallSig,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Connection lost");
  });

  it("S7: non-matching stderr chatter -> still re-arms idle", async () => {
    // A CLI that streams diagnostic text on stderr (non-matching) must behave as
    // today: each chunk resets the idle timer and the child survives. The child
    // exits cleanly so the run resolves with exitCode 0.
    const script =
      "let n=0; const iv=setInterval(()=>{ if(++n>5){ clearInterval(iv); process.exit(0);} console.error('diag line'); }, 20);";
    const r = await runCommand(process.execPath, ["-e", script], {
      idleTimeoutMs: 200,
      timeoutMs: 30_000,
      stallSignatures: stallSig,
    });
    expect(r.exitCode).toBe(0);
  });

  it("S8: after AgentStalledError the child AND a grandchild it forked are both dead", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "exec-stall-"));
    const marker = join(workDir, "grandchild.log");
    const pidFile = join(workDir, "grandchild.pid");
    try {
      // The child forks a grandchild that keeps appending to a file. The process
      // group kill must reap both. The child spawns the grandchild first, records
      // its PID, then emits stall lines to trigger the stall detector.
      const childScript =
        "const {spawn}=require('node:child_process');" +
        "const fs=require('node:fs');" +
        "const marker=process.argv[1];" +
        "const pidFile=process.argv[2];" +
        "const gc=spawn(process.execPath,['-e'," +
        '\'const fs=require("node:fs");setInterval(()=>{try{fs.appendFileSync(process.argv[1],"x")}catch(e){}},50)\',' +
        'marker,{stdio:"ignore"}]);' +
        "fs.writeFileSync(pidFile,String(gc.pid));" +
        "process.stderr.write('Connection lost, reconnecting to https://agentn.global.api5.cursor.sh (attempt 1)...\\n');" +
        "process.stderr.write('Retry attempt 1...\\n');" +
        "process.stderr.write('Connection lost, reconnecting to https://agentn.global.api5.cursor.sh (attempt 2)...\\n');" +
        "process.stderr.write('Retry attempt 2...\\n');" +
        "setTimeout(()=>{},30000);";

      const err = await runCommand(process.execPath, ["-e", childScript, marker, pidFile], {
        idleTimeoutMs: 60_000,
        timeoutMs: 60_000,
        stallSignatures: stallSig,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AgentStalledError);

      // Let any in-flight write settle, then confirm the grandchild is dead.
      await delay(300);
      const gcPid = Number(readFileSync(pidFile, "utf8").trim());
      // Grandchild must be dead: process.kill(pid, 0) throws ESRCH when gone.
      expect(() => process.kill(gcPid, 0)).toThrow();
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("S9: a signature SPLIT ACROSS TWO data chunks -> still detected", async () => {
    // Force the child to write the stall line in two separate writes with a
    // setImmediate between them, so Node's data event may split it across chunks.
    const line =
      "Connection lost, reconnecting to https://agentn.global.api5.cursor.sh (attempt 1)...";
    const half = Math.ceil(line.length / 2);
    // Use Buffer.from to avoid shell-escaping issues.
    const script = [
      `process.stderr.write(Buffer.from(${JSON.stringify(line.slice(0, half))}, 'utf8'));`,
      `setImmediate(()=>process.stderr.write(Buffer.from(${JSON.stringify(line.slice(half) + "\n")}, 'utf8')));`,
      `setImmediate(()=>process.stderr.write('Retry attempt 1...\\n'));`,
      `setImmediate(()=>process.stderr.write(Buffer.from(${JSON.stringify("Connection lost, reconnecting to https://agentn.global.api5.cursor.sh (attempt 2)..." + "\n")}, 'utf8')));`,
      `setImmediate(()=>process.stderr.write('Retry attempt 2...\\n'));`,
      `setTimeout(()=>{},30000);`,
    ].join("");

    const start = Date.now();
    const err = await runCommand(process.execPath, ["-e", script], {
      idleTimeoutMs: 60_000,
      timeoutMs: 60_000,
      stallSignatures: stallSig,
    }).catch((e: unknown) => e);
    const elapsed = Date.now() - start;
    expect(err).toBeInstanceOf(AgentStalledError);
    expect(elapsed).toBeLessThan(5_000);
  });

  it("S10: signature line wrapped in ANSI colour codes -> still detected", async () => {
    // Use the actual ESC character (0x1B) to wrap the signature in ANSI colour.
    const esc = "\u001B[31m";
    const reset = "\u001B[0m";
    const line1 =
      "Connection lost, reconnecting to https://agentn.global.api5.cursor.sh (attempt 1)...";
    const line2 =
      "Connection lost, reconnecting to https://agentn.global.api5.cursor.sh (attempt 2)...";
    // Build the script using Buffer.from to avoid shell-escaping issues with ESC.
    const script = [
      `process.stderr.write(Buffer.from(${JSON.stringify(esc + line1 + reset + "\n")}, 'utf8'));`,
      `process.stderr.write('Retry attempt 1...\\n');`,
      `process.stderr.write(Buffer.from(${JSON.stringify(esc + line2 + reset + "\n")}, 'utf8'));`,
      `process.stderr.write('Retry attempt 2...\\n');`,
      `setTimeout(()=>{},30000);`,
    ].join("");

    const err = await runCommand(process.execPath, ["-e", script], {
      idleTimeoutMs: 60_000,
      timeoutMs: 60_000,
      stallSignatures: stallSig,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentStalledError);
    // The signature stored on the error is the ANSI-stripped text.
    expect((err as AgentStalledError).signature).not.toContain("\u001B");
  });

  it("S11: stall fires, then buffered output would breach maxOutputBytes -> AgentStalledError, NOT OutputLimitError", async () => {
    // The stall detector fires BEFORE the output cap has a chance to breach.
    // Even though the child would later exceed maxOutputBytes, the stall cause
    // is recorded first and the single-terminal-cause discipline ensures the
    // stall error wins.
    const script =
      stallChildScript(2) +
      // After the stall lines, flood stdout past a tiny cap.
      "setInterval(()=>process.stdout.write(Buffer.alloc(4096, 120)), 1);";

    const err = await runCommand(process.execPath, ["-e", script], {
      idleTimeoutMs: 60_000,
      timeoutMs: 60_000,
      maxOutputBytes: 1024,
      stallSignatures: stallSig,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentStalledError);
    expect(err).not.toBeInstanceOf(OutputLimitError);
  });

  it("S12: after AgentStalledError, a subsequent runCommand still acquires a semaphore slot", async () => {
    // The stall path kills the group and rejects on `close`, so the semaphore
    // permit is released. A follow-up run must succeed (not throw ServerBusy).
    const marker = join(tmpdir(), `exec-stall-sem-${Date.now()}.log`);
    try {
      await runCommand(process.execPath, ["-e", stallChildScript(2)], {
        idleTimeoutMs: 60_000,
        timeoutMs: 60_000,
        stallSignatures: stallSig,
      }).catch(() => {});
      const r = await runCommand(process.execPath, [
        "-e",
        `require('node:fs').writeFileSync('${marker}','ok')`,
      ]);
      expect(r.exitCode).toBe(0);
      expect(readFileSync(marker, "utf8")).toBe("ok");
    } finally {
      rmSync(marker, { force: true });
    }
  });

  it("S13: two attempt lines in ONE stderr write -> AgentStalledError, not idle", async () => {
    // A single stderr.write() containing three lines (two "connection lost" + one "retry")
    // must be detected as a stall — not misclassified as idle. The child stays silent
    // after the write, so the stall detector is the only thing that can end it quickly.
    // Both attempt lines in one chunk must be processed (attempt 2 reaches the threshold).
    const script =
      'process.stderr.write("Connection lost, reconnecting to https://x.example (attempt 1)...\\n' +
      "Retry attempt 1...\\n" +
      'Connection lost, reconnecting to https://x.example (attempt 2)...\\n");' +
      "setTimeout(() => {}, 10000);";

    const start = Date.now();
    const err = await runCommand(process.execPath, ["-e", script], {
      idleTimeoutMs: 30_000,
      timeoutMs: 60_000,
      stallSignatures: stallSig,
    }).catch((e: unknown) => e);
    const elapsed = Date.now() - start;
    expect(err).toBeInstanceOf(AgentStalledError);
    expect((err as AgentStalledError).code).toBe("stream_stalled");
    expect((err as AgentStalledError).strikes).toBeGreaterThanOrEqual(2);
    // Far under both caps — proves the stall detector fired, not a timeout.
    expect(elapsed).toBeLessThan(3_000);
  });

  it("S14: two separate attempt-1 reconnect cycles (max attempt == 1) -> idle, NOT stall", async () => {
    // Two complete reconnect cycles, each resetting to attempt 1, must NOT trigger
    // the stall fallback. Four matched lines but max attempt 1 and zero attempt-less
    // strikes => the strike fallback must NOT fire. The child dies only by idle.
    const script =
      'process.stderr.write("Connection lost, reconnecting to https://x.example (attempt 1)...\\n' +
      'Retry attempt 1...\\n");' +
      'setTimeout(() => { process.stderr.write("Connection lost, reconnecting to https://x.example (attempt 1)...\\n' +
      'Retry attempt 1...\\n"); }, 120);' +
      "setTimeout(() => {}, 10000);";

    const err = await runCommand(process.execPath, ["-e", script], {
      idleTimeoutMs: 400,
      timeoutMs: 60_000,
      // All three cursor patterns, so BOTH the "connection lost" and "retry
      // attempt" lines match — four matched, attempt-numbered lines across two
      // cycles. A raw-strike fallback would fire at four; keying on the distinct
      // attempt number (still 1) must not.
      stallSignatures: cursorAdapter.stallSignatures,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as TimeoutError).kind).toBe("idle");
  });

  it("S15: bare no-attempt signature repeated >=4 times -> AgentStalledError via strike fallback", async () => {
    // A signature that carries no attempt number (e.g. "RetriableError: …") must
    // still stall when repeated enough times. The strike fallback (stallNoAttemptStrikes
    // >= stallStrikeLimit) is the only path here — attempt counters never increment.
    const script =
      "let n=0;" +
      "function w(){if(++n<=5){process.stderr.write('RetriableError: Connection stalled\\n');setTimeout(w,30)}else{setTimeout(()=>{},30000)}}" +
      "w();";

    const err = await runCommand(process.execPath, ["-e", script], {
      idleTimeoutMs: 60_000,
      timeoutMs: 60_000,
      stallSignatures: cursorAdapter.stallSignatures,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentStalledError);
    expect((err as AgentStalledError).code).toBe("stream_stalled");
    // Proves the strike fallback (stallNoAttemptStrikes >= 4) works for
    // signatures that carry no attempt number.
  });
});
