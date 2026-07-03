import { describe, expect, it } from "vitest";
import { cursorAdapter } from "../../src/adapters/cursor.js";

describe("cursorAdapter", () => {
  it("builds print-mode args and pipes the prompt via stdin", () => {
    expect(cursorAdapter.buildInvocation("explain this repo")).toEqual({
      args: ["-p", "--output-format", "text"],
      stdin: "explain this repo",
    });
  });

  it("appends --model when given", () => {
    expect(cursorAdapter.buildInvocation("explain this repo", { model: "gpt-5" })).toEqual({
      args: ["-p", "--output-format", "text", "--model", "gpt-5"],
      stdin: "explain this repo",
    });
  });

  it("is injection-safe for prompts that look like flags", () => {
    const inv = cursorAdapter.buildInvocation("--force what does this flag do");
    expect(inv.args).toEqual(["-p", "--output-format", "text"]);
    expect(inv.stdin).toBe("--force what does this flag do");
  });

  it("exposes correct identity", () => {
    expect(cursorAdapter.name).toBe("cursor");
    expect(cursorAdapter.binary).toBe("cursor-agent");
  });
});
