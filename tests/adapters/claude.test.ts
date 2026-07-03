import { describe, expect, it } from "vitest";
import { claudeAdapter } from "../../src/adapters/claude.js";

describe("claudeAdapter", () => {
  it("builds print-mode args and pipes the prompt via stdin", () => {
    expect(claudeAdapter.buildInvocation("explain this repo")).toEqual({
      args: ["-p", "--output-format", "text"],
      stdin: "explain this repo",
    });
  });

  it("appends --model when given", () => {
    expect(claudeAdapter.buildInvocation("explain this repo", { model: "opus" })).toEqual({
      args: ["-p", "--output-format", "text", "--model", "opus"],
      stdin: "explain this repo",
    });
  });

  it("is injection-safe for prompts that look like flags", () => {
    const inv = claudeAdapter.buildInvocation("--force what does this flag do");
    expect(inv.args).toEqual(["-p", "--output-format", "text"]);
    expect(inv.stdin).toBe("--force what does this flag do");
  });

  it("exposes correct identity", () => {
    expect(claudeAdapter.name).toBe("claude");
    expect(claudeAdapter.binary).toBe("claude");
  });
});
