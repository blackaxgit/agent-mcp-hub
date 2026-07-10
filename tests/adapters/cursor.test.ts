import { describe, expect, it } from "vitest";
import { cursorAdapter } from "../../src/adapters/cursor.js";

describe("cursorAdapter", () => {
  it("builds print-mode args and pipes the prompt via stdin", () => {
    expect(cursorAdapter.buildInvocation("explain this repo")).toEqual({
      args: ["-p", "--output-format", "text", "--trust"],
      stdin: "explain this repo",
    });
  });

  it("appends --model when given", () => {
    expect(cursorAdapter.buildInvocation("explain this repo", { model: "gpt-5" })).toEqual({
      args: ["-p", "--output-format", "text", "--trust", "--model", "gpt-5"],
      stdin: "explain this repo",
    });
  });

  it("is injection-safe for prompts that look like flags", () => {
    const inv = cursorAdapter.buildInvocation("--force what does this flag do");
    expect(inv.args).toEqual(["-p", "--output-format", "text", "--trust"]);
    expect(inv.stdin).toBe("--force what does this flag do");
  });

  // Without --trust, cursor-agent blocks on an interactive "Workspace Trust Required"
  // prompt in any directory it has not seen before. Print mode gives it no stdin to
  // answer with, so the run hangs until the idle timeout kills it. The server is
  // invoked against arbitrary cwds, so this flag is load-bearing, not cosmetic.
  it("always passes --trust so an unfamiliar cwd cannot hang the run", () => {
    expect(cursorAdapter.buildInvocation("hi").args).toContain("--trust");
    expect(cursorAdapter.buildInvocation("hi", { model: "gpt-5" }).args).toContain("--trust");
  });

  it("exposes correct identity", () => {
    expect(cursorAdapter.name).toBe("cursor");
    expect(cursorAdapter.binary).toBe("cursor-agent");
  });

  it("exposes remediation metadata", () => {
    expect(cursorAdapter.loginCommand).toBe("cursor-agent login");
    expect(cursorAdapter.apiKeyEnv).toBe("CURSOR_API_KEY");
  });

  // `cursor-agent models` requires a valid account, so exit 0 proves authentication,
  // which `--version` never does. probeRequiresOutput must stay falsy: the output is
  // prose ("gpt-5.3-codex-low - Codex 5.3 Low"), so the bare-identifier heuristic
  // would find nothing and condemn a healthy CLI.
  it("probes with `models` but does not require identifier-shaped output", () => {
    expect(cursorAdapter.probeArgs).toEqual(["models"]);
    expect(cursorAdapter.probeRequiresOutput).toBeFalsy();
  });
});
