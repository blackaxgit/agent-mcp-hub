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

  describe("permission mode", () => {
    it("treats an omitted permissionMode exactly like an explicit write", () => {
      expect(claudeAdapter.buildInvocation("hi").args).toEqual(
        claudeAdapter.buildInvocation("hi", { permissionMode: "write" }).args,
      );
    });

    it("adds no permission flags in write mode", () => {
      const args = claudeAdapter.buildInvocation("hi", { permissionMode: "write" }).args;
      expect(args).not.toContain("--disallowedTools");
      expect(args).not.toContain("--dangerously-skip-permissions");
    });

    // Deny rules are evaluated before the tool runs and hold in EVERY permission
    // mode, so this is a genuine harness-level restriction, not advice.
    it("denies the write/exec tools as a single GLUED token in read-only mode", () => {
      const args = claudeAdapter.buildInvocation("hi", { permissionMode: "read-only" }).args;
      // Glued: the flag is variadic, so as a separate token it greedily consumes
      // following non-flag argv entries (observed eating a positional prompt).
      expect(args).toContain("--disallowedTools=Write,Edit,NotebookEdit,Bash");
      expect(args).not.toContain("--disallowedTools");
    });

    // An unknown tool name does not fail — it prints `Permission deny rule "X"
    // matches no known tool` and protects nothing. MultiEdit does not exist in
    // current Claude Code and was silently dead weight in this list.
    it("lists only tool names that actually exist (no MultiEdit)", () => {
      const args = claudeAdapter.buildInvocation("hi", { permissionMode: "read-only" }).args;
      const denied = args
        .find((a) => a.startsWith("--disallowedTools="))!
        .split("=")[1]!
        .split(",");
      expect(denied).toEqual(["Write", "Edit", "NotebookEdit", "Bash"]);
      expect(denied).not.toContain("MultiEdit");
    });

    it("never emits --dangerously-skip-permissions in either mode", () => {
      for (const mode of ["write", "read-only"] as const) {
        expect(claudeAdapter.buildInvocation("hi", { permissionMode: mode }).args).not.toContain(
          "--dangerously-skip-permissions",
        );
      }
    });
  });

  it("exposes correct identity", () => {
    expect(claudeAdapter.name).toBe("claude");
    expect(claudeAdapter.binary).toBe("claude");
  });

  it("exposes remediation metadata", () => {
    expect(claudeAdapter.loginCommand).toBe("claude  (then /login)");
    expect(claudeAdapter.apiKeyEnv).toBe("ANTHROPIC_API_KEY");
  });
});
