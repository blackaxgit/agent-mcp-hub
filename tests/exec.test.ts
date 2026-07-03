import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_TIMEOUT_MS,
  MAX_CONCURRENT_AGENTS,
  ServerBusyError,
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

  it("defaults the timeout to 300000ms", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(300_000);
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
