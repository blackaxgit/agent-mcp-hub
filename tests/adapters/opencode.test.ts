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

  // opencode exposes NO read-only lever on `run`, so permissionMode is a
  // documented no-op here. This test exists to make that gap explicit and
  // deliberate: an opencode REVIEWER is NOT restricted. If opencode ever gains a
  // read-only flag, this test should fail and be replaced.
  it("ignores permissionMode — argv is identical in both modes (documented gap)", () => {
    const write = opencodeAdapter.buildInvocation("write tests", { permissionMode: "write" });
    const readOnly = opencodeAdapter.buildInvocation("write tests", {
      permissionMode: "read-only",
    });
    expect(readOnly).toEqual(write);
    expect(readOnly.args).toEqual(opencodeAdapter.buildInvocation("write tests").args);
  });

  // Never emitted: opencode already writes files without it (verified live), so
  // passing it would only widen permissions.
  it("never emits --auto", () => {
    for (const mode of ["write", "read-only"] as const) {
      expect(opencodeAdapter.buildInvocation("x", { permissionMode: mode }).args).not.toContain(
        "--auto",
      );
    }
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
