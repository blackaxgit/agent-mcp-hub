import { describe, expect, it } from "vitest";
import {
  CANCEL_TAIL,
  CONFIRM_SCHEMA,
  buildConfirmMessage,
  buildRunAllMessage,
  confirmEnabled,
  truncate,
} from "../src/confirm.js";

describe("confirmEnabled", () => {
  it("is true for the enabling values, case- and whitespace-insensitive", () => {
    for (const v of ["1", "true", "on", "all", "ON", "True", " all ", "\tTRUE\n"]) {
      expect(confirmEnabled({ MCP_CONFIRM: v })).toBe(true);
    }
  });

  it("is false for disabling, unknown, or absent values", () => {
    for (const v of ["0", "off", "yes", "no", "false", "enabled", "2", "garbage", ""]) {
      expect(confirmEnabled({ MCP_CONFIRM: v })).toBe(false);
    }
    expect(confirmEnabled({})).toBe(false);
  });

  it("defaults to process.env when called with no argument", () => {
    const prev = process.env.MCP_CONFIRM;
    try {
      delete process.env.MCP_CONFIRM;
      expect(confirmEnabled()).toBe(false);
      process.env.MCP_CONFIRM = "on";
      expect(confirmEnabled()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.MCP_CONFIRM;
      else process.env.MCP_CONFIRM = prev;
    }
  });
});

describe("truncate", () => {
  it("returns the input unchanged when its length is <= max", () => {
    expect(truncate("hello", 5)).toBe("hello");
    expect(truncate("hi", 5)).toBe("hi");
    expect(truncate("", 5)).toBe("");
  });

  it("truncates to <= max INCLUDING the ellipsis when longer than max", () => {
    const out = truncate("abcdef", 5);
    expect(out.length).toBeLessThanOrEqual(5);
    expect(out.endsWith("…")).toBe(true);
    expect(out).toBe("abcd…");
  });

  it("handles the len==max+1 boundary", () => {
    const s = "x".repeat(11);
    const out = truncate(s, 10);
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out.endsWith("…")).toBe(true);
  });

  it("returns the empty string when max < 1", () => {
    expect(truncate("anything", 0)).toBe("");
    expect(truncate("anything", -3)).toBe("");
  });
});

describe("buildConfirmMessage", () => {
  it("names the agent and includes cwd and model when present", () => {
    const msg = buildConfirmMessage("codex", {
      prompt: "do the thing",
      model: "gpt-5",
      cwd: "/repo",
    });
    expect(msg).toContain("codex");
    expect(msg).toContain("do the thing");
    expect(msg).toContain("/repo");
    expect(msg).toContain("gpt-5");
  });

  it("omits the cwd and model lines when they are undefined", () => {
    const msg = buildConfirmMessage("codex", { prompt: "hi" });
    expect(msg).not.toMatch(/cwd/i);
    expect(msg).not.toMatch(/model/i);
    expect(msg).toContain("codex");
    expect(msg).toContain("hi");
  });

  it("truncates a long prompt to <= 300 chars ending with the ellipsis", () => {
    const long = "a".repeat(1000);
    const msg = buildConfirmMessage("codex", { prompt: long });
    const promptLine = msg.split("\n").find((l) => l.includes("aaaa"))!;
    expect(promptLine).toMatch(/…$/);
    // the truncated prompt itself is <= 300 chars
    expect(truncate(long, 300).length).toBeLessThanOrEqual(300);
    expect(msg).toContain(truncate(long, 300));
  });
});

describe("buildRunAllMessage", () => {
  it("lists EVERY provided agent name and the truncated prompt", () => {
    const names = ["codex", "cursor", "opencode", "claude"];
    const msg = buildRunAllMessage(names, { prompt: "run everything", cwd: "/w" });
    for (const n of names) expect(msg).toContain(n);
    expect(msg).toContain("run everything");
    expect(msg).toContain("/w");
  });

  it("omits cwd when undefined and truncates a long prompt", () => {
    const long = "b".repeat(1000);
    const msg = buildRunAllMessage(["codex"], { prompt: long });
    expect(msg).not.toMatch(/cwd/i);
    expect(msg).toContain(truncate(long, 300));
  });
});

describe("CONFIRM_SCHEMA", () => {
  it("declares a required boolean confirm property", () => {
    expect(CONFIRM_SCHEMA.type).toBe("object");
    expect(CONFIRM_SCHEMA.properties.confirm.type).toBe("boolean");
    expect(CONFIRM_SCHEMA.required).toContain("confirm");
  });
});

describe("CANCEL_TAIL", () => {
  it("is the exact canonical cancel wording", () => {
    expect(CANCEL_TAIL).toBe(
      "run cancelled by user — nothing was executed. Do not retry unless the user asks.",
    );
  });
});
