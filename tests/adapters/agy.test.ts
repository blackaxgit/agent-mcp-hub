import { describe, expect, it } from "vitest";
import { agyAdapter } from "../../src/adapters/agy.js";

describe("agyAdapter identity and remediation metadata", () => {
  it("exposes the tool name and the binary it resolves on PATH", () => {
    expect(agyAdapter.name).toBe("agy");
    expect(agyAdapter.binary).toBe("agy");
  });

  it("names Antigravity in the summary so a client can tell what `agy` is", () => {
    expect(agyAdapter.summary).toMatch(/antigravity/i);
  });

  it("carries a login hint and NO api-key env var (agy uses the OS keyring)", () => {
    expect(agyAdapter.loginCommand).toMatch(/agy/);
    // Load-bearing: because this is undefined, agy contributes nothing to
    // allCredentialEnvVars() yet has EVERY sibling key stripped from its env.
    expect(agyAdapter.apiKeyEnv).toBeUndefined();
  });

  it("probes with `models` AND requires output — exit 0 alone must not prove usability", () => {
    expect(agyAdapter.probeArgs).toEqual(["models"]);
    // Regression guard: dropping this would let an unauthenticated agy that
    // exits 0 while listing nothing report `usable: true`.
    expect(agyAdapter.probeRequiresOutput).toBe(true);
  });
});

describe("agyAdapter.buildInvocation", () => {
  it("passes the prompt as the GLUED value of --print and never uses stdin", () => {
    const { args, stdin } = agyAdapter.buildInvocation("do the thing");
    expect(args).toContain("--print=do the thing");
    // agy reads the prompt from argv, not stdin — unlike codex/cursor/claude.
    expect(stdin).toBeUndefined();
  });

  it("puts the prompt in ONE argv token so it can never be re-parsed as a flag", () => {
    const { args } = agyAdapter.buildInvocation("-rm -rf --dangerously-skip-permissions");
    // The whole prompt is glued to --print: no bare token starts with '-'
    // that the CLI could pick up as a separate flag.
    expect(args).toContain("--print=-rm -rf --dangerously-skip-permissions");
    expect(args.filter((a) => a === "-rm" || a === "-rf")).toEqual([]);
  });

  it("accepts a dash-leading prompt without throwing (unlike opencode)", () => {
    expect(() => agyAdapter.buildInvocation("--help me refactor")).not.toThrow();
    expect(agyAdapter.buildInvocation("--help me refactor").args).toContain(
      "--print=--help me refactor",
    );
  });

  // Each load-bearing flag is asserted INDIVIDUALLY so a later "simplification"
  // that removes exactly one of them fails a named test — the lesson from the
  // cursor `--trust` incident.
  it("always passes --new-project, without which agy ignores cwd entirely", () => {
    expect(agyAdapter.buildInvocation("x").args).toContain("--new-project");
  });

  it("always raises --print-timeout above the hub's own 24h ceiling", () => {
    const { args } = agyAdapter.buildInvocation("x");
    const i = args.indexOf("--print-timeout");
    expect(i).toBeGreaterThanOrEqual(0);
    // Must exceed MAX_TIMEOUT_MS (24h) so the hub's timers always fire first.
    expect(args[i + 1]).toBe("48h");
  });

  it("auto-approves tool use by default, else agy exits 0 with empty output", () => {
    expect(agyAdapter.buildInvocation("x").args).toContain("--dangerously-skip-permissions");
    expect(agyAdapter.buildInvocation("x", {}).args).toContain("--dangerously-skip-permissions");
    expect(agyAdapter.buildInvocation("x", { permissionMode: "write" }).args).toContain(
      "--dangerously-skip-permissions",
    );
  });

  it("treats an omitted permissionMode exactly like an explicit write", () => {
    expect(agyAdapter.buildInvocation("x").args).toEqual(
      agyAdapter.buildInvocation("x", { permissionMode: "write" }).args,
    );
  });

  it("WITHHOLDS tool auto-approval when judging untrusted input (review_change reviewer)", () => {
    const { args } = agyAdapter.buildInvocation("x", { permissionMode: "read-only" });
    expect(args).not.toContain("--dangerously-skip-permissions");
    // Everything else still applies — only the approval grant is withheld.
    expect(args).toContain("--new-project");
    expect(args).toContain("--print=x");
  });

  // Upstream #36: combined with the skip flag, --sandbox lets the agent approve
  // its own sandbox escape; alone it yields no usable read-only mode.
  it("never emits --sandbox in either mode", () => {
    for (const mode of ["write", "read-only"] as const) {
      expect(agyAdapter.buildInvocation("x", { permissionMode: mode }).args).not.toContain(
        "--sandbox",
      );
    }
  });

  it("forwards a model as --model <value> and omits it when absent", () => {
    const withModel = agyAdapter.buildInvocation("x", { model: "gemini-3.1-pro-high" });
    expect(withModel.args).toContain("--model");
    expect(withModel.args[withModel.args.indexOf("--model") + 1]).toBe("gemini-3.1-pro-high");
    expect(agyAdapter.buildInvocation("x").args).not.toContain("--model");
  });

  it("emits the full expected argv in order", () => {
    expect(agyAdapter.buildInvocation("hello", { model: "m" }).args).toEqual([
      "--new-project",
      "--print-timeout",
      "48h",
      "--dangerously-skip-permissions",
      "--model",
      "m",
      "--print=hello",
    ]);
  });
});
