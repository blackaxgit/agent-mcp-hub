import { describe, expect, it } from "vitest";
import { opencodeAdapter } from "../../src/adapters/opencode.js";

describe("opencodeAdapter", () => {
  it("builds run args with a positional prompt", () => {
    expect(opencodeAdapter.buildInvocation("write tests")).toEqual({
      args: ["run", "write tests"],
    });
  });

  it("inserts --model before the prompt when given", () => {
    expect(
      opencodeAdapter.buildInvocation("write tests", { model: "anthropic/claude-sonnet-5" }),
    ).toEqual({
      args: ["run", "--model", "anthropic/claude-sonnet-5", "write tests"],
    });
  });

  it("rejects prompts starting with '-' with an actionable error", () => {
    expect(() => opencodeAdapter.buildInvocation("--help me")).toThrow(
      /prompts that start with '-'/,
    );
  });

  it("exposes correct identity", () => {
    expect(opencodeAdapter.name).toBe("opencode");
    expect(opencodeAdapter.binary).toBe("opencode");
  });

  it("exposes remediation metadata", () => {
    expect(opencodeAdapter.loginCommand).toBe("opencode auth login");
    expect(opencodeAdapter.apiKeyEnv).toBeUndefined();
  });
});
