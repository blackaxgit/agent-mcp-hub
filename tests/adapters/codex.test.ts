import { describe, expect, it } from "vitest";
import { codexAdapter } from "../../src/adapters/codex.js";

describe("codexAdapter", () => {
  it("pipes the prompt via stdin using the '-' sentinel", () => {
    expect(codexAdapter.buildInvocation("fix the bug")).toEqual({
      args: ["exec", "--skip-git-repo-check", "-s", "workspace-write", "-"],
      stdin: "fix the bug",
    });
  });

  it("inserts --model before the stdin sentinel when given", () => {
    expect(codexAdapter.buildInvocation("fix the bug", { model: "o3" })).toEqual({
      args: ["exec", "--skip-git-repo-check", "--model", "o3", "-s", "workspace-write", "-"],
      stdin: "fix the bug",
    });
  });

  it("is injection-safe for prompts that look like flags", () => {
    const inv = codexAdapter.buildInvocation("--help me understand this");
    expect(inv.args).toEqual(["exec", "--skip-git-repo-check", "-s", "workspace-write", "-"]);
    expect(inv.stdin).toBe("--help me understand this");
  });

  // `codex exec` defaults to a READ-ONLY sandbox. Without an explicit -s the tool
  // answered "DONE" and wrote nothing — success-shaped silence. These tests pin
  // the fix so it cannot be "simplified" away again.
  describe("sandbox / permission mode", () => {
    it("defaults to workspace-write so the agent can actually edit files", () => {
      const args = codexAdapter.buildInvocation("x").args;
      expect(args).toContain("-s");
      expect(args[args.indexOf("-s") + 1]).toBe("workspace-write");
    });

    it("emits -s read-only for a read-only run", () => {
      const args = codexAdapter.buildInvocation("x", { permissionMode: "read-only" }).args;
      expect(args[args.indexOf("-s") + 1]).toBe("read-only");
      expect(args).not.toContain("workspace-write");
    });

    it("treats an omitted permissionMode exactly like an explicit write", () => {
      expect(codexAdapter.buildInvocation("x").args).toEqual(
        codexAdapter.buildInvocation("x", { permissionMode: "write" }).args,
      );
    });

    it("emits -s BEFORE the '-' sentinel so the prompt is never positional", () => {
      for (const mode of ["write", "read-only"] as const) {
        const args = codexAdapter.buildInvocation("x", { permissionMode: mode }).args;
        expect(args.indexOf("-s")).toBeLessThan(args.indexOf("-"));
        expect(args[args.length - 1]).toBe("-");
      }
    });

    it("NEVER emits the bypass flag, which would nullify --sandbox", () => {
      for (const mode of ["write", "read-only"] as const) {
        expect(codexAdapter.buildInvocation("x", { permissionMode: mode }).args).not.toContain(
          "--dangerously-bypass-approvals-and-sandbox",
        );
      }
    });
  });

  it("exposes correct identity", () => {
    expect(codexAdapter.name).toBe("codex");
    expect(codexAdapter.binary).toBe("codex");
  });

  it("exposes remediation metadata", () => {
    expect(codexAdapter.loginCommand).toBe("codex login");
    expect(codexAdapter.apiKeyEnv).toBe("OPENAI_API_KEY");
  });
});
