import { describe, expect, it, vi } from "vitest";
import type { Exec } from "../src/exec.js";
import { allAdapters, checkAvailability, enabledAdapters } from "../src/registry.js";
import { codexAdapter } from "../src/adapters/codex.js";

describe("allAdapters", () => {
  it("returns codex, cursor, opencode, and claude in stable order", () => {
    expect(allAdapters().map((a) => a.name)).toEqual(["codex", "cursor", "opencode", "claude"]);
  });
});

describe("enabledAdapters", () => {
  it("returns all adapters when MCP_AGENTS is unset", () => {
    expect(enabledAdapters(undefined).map((a) => a.name)).toEqual([
      "codex",
      "cursor",
      "opencode",
      "claude",
    ]);
  });

  it("returns all adapters when the spec parses to no names", () => {
    expect(enabledAdapters(",").map((a) => a.name)).toEqual([
      "codex",
      "cursor",
      "opencode",
      "claude",
    ]);
  });

  it("returns exactly the named subset in registry order, trimming whitespace", () => {
    expect(enabledAdapters("codex, claude").map((a) => a.name)).toEqual(["codex", "claude"]);
  });

  it("dedupes repeated names", () => {
    expect(enabledAdapters("codex,codex").map((a) => a.name)).toEqual(["codex"]);
  });

  it("throws naming the invalid entry and listing valid agents for unknown names", () => {
    expect(() => enabledAdapters("clade")).toThrowError(
      'Unknown agent "clade" in MCP_AGENTS. Valid agents: codex, cursor, opencode, claude',
    );
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
