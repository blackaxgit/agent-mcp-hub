import { describe, expect, it } from "vitest";
import { DEFAULT_TIMEOUT_MS, runCommand } from "../src/exec.js";

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
