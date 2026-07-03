import { describe, expect, it, vi } from "vitest";
import type { Exec } from "../src/exec.js";
import { allAdapters, checkAvailability } from "../src/registry.js";
import { codexAdapter } from "../src/adapters/codex.js";

describe("allAdapters", () => {
  it("returns codex, cursor, and opencode in stable order", () => {
    expect(allAdapters().map((a) => a.name)).toEqual(["codex", "cursor", "opencode"]);
  });
});

describe("checkAvailability", () => {
  it("returns true when --version exits 0", async () => {
    const exec: Exec = vi.fn(async () => ({ stdout: "1.0.0\n", stderr: "", exitCode: 0 }));
    await expect(checkAvailability(codexAdapter, exec)).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith("codex", ["--version"], { timeoutMs: 10_000 });
  });

  it("returns false when --version exits non-zero", async () => {
    const exec: Exec = vi.fn(async () => ({ stdout: "", stderr: "bad", exitCode: 1 }));
    await expect(checkAvailability(codexAdapter, exec)).resolves.toBe(false);
  });

  it("returns false instead of throwing when the binary is missing", async () => {
    const exec: Exec = vi.fn(async () => {
      throw new Error("Failed to start");
    });
    await expect(checkAvailability(codexAdapter, exec)).resolves.toBe(false);
  });
});
