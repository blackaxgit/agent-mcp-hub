import { describe, expect, it } from "vitest";
import { codexAdapter } from "../../src/adapters/codex.js";

describe("codexAdapter", () => {
  it("pipes the prompt via stdin using the '-' sentinel", () => {
    expect(codexAdapter.buildInvocation("fix the bug")).toEqual({
      args: ["exec", "--skip-git-repo-check", "-"],
      stdin: "fix the bug",
    });
  });

  it("inserts --model before the stdin sentinel when given", () => {
    expect(codexAdapter.buildInvocation("fix the bug", { model: "o3" })).toEqual({
      args: ["exec", "--skip-git-repo-check", "--model", "o3", "-"],
      stdin: "fix the bug",
    });
  });

  it("is injection-safe for prompts that look like flags", () => {
    const inv = codexAdapter.buildInvocation("--help me understand this");
    expect(inv.args).toEqual(["exec", "--skip-git-repo-check", "-"]);
    expect(inv.stdin).toBe("--help me understand this");
  });

  it("exposes correct identity", () => {
    expect(codexAdapter.name).toBe("codex");
    expect(codexAdapter.binary).toBe("codex");
  });
});
