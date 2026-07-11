import { basename, dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Exec } from "../src/exec.js";
import {
  allAdapters,
  checkAvailability,
  enabledAdapters,
  parseProbeIds,
  resolveOnPath,
  type ResolveBinary,
} from "../src/registry.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { cursorAdapter } from "../src/adapters/cursor.js";
import { opencodeAdapter } from "../src/adapters/opencode.js";

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

describe("resolveOnPath", () => {
  it("accepts an absolute path to a real executable", () => {
    // process.execPath is the running node binary: absolute, a file, executable.
    expect(resolveOnPath(process.execPath)).toBe(process.execPath);
  });

  it("rejects an absolute path that is not an executable file", () => {
    expect(resolveOnPath("/")).toBeUndefined();
    expect(resolveOnPath("/definitely/not/here/agent-xyz")).toBeUndefined();
  });

  it("finds a bare name by walking PATH, and returns undefined when absent", () => {
    const dir = dirname(process.execPath);
    const name = basename(process.execPath);
    expect(resolveOnPath(name, dir)).toBe(join(dir, name));
    expect(resolveOnPath("agent-mcp-hub-nonexistent-xyz", dir)).toBeUndefined();
  });

  it("returns undefined when PATH is empty rather than throwing", () => {
    expect(resolveOnPath("agent-mcp-hub-nonexistent-xyz", "")).toBeUndefined();
  });
});

describe("parseProbeIds", () => {
  it("keeps identifier-shaped lines and drops prose", () => {
    expect(parseProbeIds("opencode/big-pickle\nopencode/mimo\n")).toEqual([
      "opencode/big-pickle",
      "opencode/mimo",
    ]);
  });

  it("treats any whitespace-containing line as prose", () => {
    expect(parseProbeIds("Available models\n\ngpt-5 - GPT Five\n")).toEqual([]);
  });
});

describe("checkAvailability", () => {
  const found: ResolveBinary = (b) => `/usr/local/bin/${b}`;
  const missing: ResolveBinary = () => undefined;

  it("is installed and usable when the probe exits 0 with clean output", async () => {
    const exec: Exec = vi.fn(async () => ({ stdout: "1.0.0\n", stderr: "", exitCode: 0 }));
    await expect(checkAvailability(codexAdapter, exec, found)).resolves.toEqual({
      name: "codex",
      installed: true,
      usable: true,
      available: true,
    });
    expect(exec).toHaveBeenCalledWith("codex", ["--version"], { timeoutMs: 10_000 });
  });

  // The regression this whole class of bug lives in: codex exits 0 from `--version`
  // while announcing it cannot write its home, then fails every real invocation.
  // Exit code alone must never be enough.
  it("is installed but NOT usable when a zero exit hides a fatal condition", async () => {
    const exec: Exec = vi.fn(async () => ({
      stdout: "codex-cli 0.142.5\n",
      stderr:
        "WARNING: proceeding, even though we could not create PATH aliases: Read-only file system (os error 30)\n",
      exitCode: 0,
    }));
    const status = await checkAvailability(codexAdapter, exec, found);
    expect(status.installed).toBe(true);
    expect(status.usable).toBe(false);
    expect(status.available).toBe(false);
    expect(status.reason).toMatch(/exited 0 but reported a fatal condition/i);
    expect(status.reason).toMatch(/read-only file system/i);
  });

  it("is installed but NOT usable when the probe exits non-zero, and says why", async () => {
    const exec: Exec = vi.fn(async () => ({ stdout: "", stderr: "boom", exitCode: 1 }));
    const status = await checkAvailability(codexAdapter, exec, found);
    expect(status).toMatchObject({ installed: true, usable: false, available: false });
    expect(status.reason).toBeTruthy();
  });

  it("reports not installed WITHOUT probing when the binary does not resolve", async () => {
    const exec: Exec = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const status = await checkAvailability(codexAdapter, exec, missing);
    expect(status).toMatchObject({ installed: false, usable: false, available: false });
    expect(status.reason).toMatch(/not found on PATH/);
    expect(exec).not.toHaveBeenCalled();
  });

  it("is installed but NOT usable instead of throwing when the probe blows up", async () => {
    const exec: Exec = vi.fn(async () => {
      throw new Error("Failed to start");
    });
    const status = await checkAvailability(codexAdapter, exec, found);
    expect(status).toMatchObject({ installed: true, usable: false, available: false });
  });

  it("uses the adapter's probeArgs and demands identifier output when required", async () => {
    const exec: Exec = vi.fn(async () => ({
      stdout: "opencode/big-pickle\n",
      stderr: "",
      exitCode: 0,
    }));
    await expect(checkAvailability(opencodeAdapter, exec, found)).resolves.toMatchObject({
      usable: true,
    });
    expect(exec).toHaveBeenCalledWith("opencode", ["models"], { timeoutMs: 10_000 });
  });

  it("is NOT usable when a probe requiring output exits 0 but lists nothing", async () => {
    const exec: Exec = vi.fn(async () => ({
      stdout: "You are not logged in.\n",
      stderr: "",
      exitCode: 0,
    }));
    const status = await checkAvailability(opencodeAdapter, exec, found);
    expect(status).toMatchObject({ installed: true, usable: false, available: false });
    expect(status.reason).toMatch(/listed nothing/);
    expect(status.reason).toMatch(/opencode auth login/);
  });

  // cursor prints prose, not bare ids, so requiring identifier output would condemn
  // a healthy CLI. Exit 0 from `cursor-agent models` already proves authentication.
  it("does not demand identifier output when the adapter has not asked for it", async () => {
    const exec: Exec = vi.fn(async () => ({
      stdout: "Available models\n\nauto - Auto (current, default)\n",
      stderr: "",
      exitCode: 0,
    }));
    await expect(checkAvailability(cursorAdapter, exec, found)).resolves.toMatchObject({
      usable: true,
    });
    expect(exec).toHaveBeenCalledWith("cursor-agent", ["models"], { timeoutMs: 10_000 });
  });
});
