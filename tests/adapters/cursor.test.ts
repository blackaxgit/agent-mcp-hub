import { describe, expect, it } from "vitest";
import { cursorAdapter } from "../../src/adapters/cursor.js";

describe("cursorAdapter", () => {
  it("builds print-mode args and pipes the prompt via stdin", () => {
    expect(cursorAdapter.buildInvocation("explain this repo")).toEqual({
      args: ["-p", "--output-format", "text", "--force"],
      stdin: "explain this repo",
    });
  });

  it("appends --model when given", () => {
    expect(cursorAdapter.buildInvocation("explain this repo", { model: "gpt-5" })).toEqual({
      args: ["-p", "--output-format", "text", "--force", "--model", "gpt-5"],
      stdin: "explain this repo",
    });
  });

  it("is injection-safe for prompts that look like flags", () => {
    const inv = cursorAdapter.buildInvocation("--force what does this flag do");
    expect(inv.args).toEqual(["-p", "--output-format", "text", "--force"]);
    expect(inv.stdin).toBe("--force what does this flag do");
  });

  // Without a trust/force flag, cursor-agent refuses to proceed in a directory it
  // has not seen before. The server is invoked against arbitrary cwds, so this is
  // load-bearing, not cosmetic.
  it("always passes --force in write mode so an unfamiliar cwd cannot block the run", () => {
    for (const args of [
      cursorAdapter.buildInvocation("hi").args,
      cursorAdapter.buildInvocation("hi", { model: "gpt-5" }).args,
      cursorAdapter.buildInvocation("hi", { permissionMode: "write" }).args,
    ]) {
      expect(args).toContain("--force");
    }
  });

  describe("permission mode", () => {
    it("treats an omitted permissionMode exactly like an explicit write", () => {
      expect(cursorAdapter.buildInvocation("hi").args).toEqual(
        cursorAdapter.buildInvocation("hi", { permissionMode: "write" }).args,
      );
    });

    // A read-only run drops the write grant and switches to plan mode. --trust is
    // REQUIRED alongside it: without a trust/force flag cursor-agent prints
    // "Pass --trust, --yolo, or -f if you trust this directory" and returns NO
    // answer at all, which would make the reviewer useless.
    //
    // NB: --trust DOES exist on cursor-agent today. An older note in this repo
    // claimed it did not (and that passing it exits 1); that is stale — the CLI's
    // own error message now recommends it.
    it("uses --trust --mode plan and drops --force for a read-only run", () => {
      const args = cursorAdapter.buildInvocation("hi", { permissionMode: "read-only" }).args;
      expect(args).toContain("--trust");
      expect(args).toContain("--mode");
      expect(args[args.indexOf("--mode") + 1]).toBe("plan");
      expect(args).not.toContain("--force");
    });

    it("still forwards --model in read-only mode", () => {
      const args = cursorAdapter.buildInvocation("hi", {
        permissionMode: "read-only",
        model: "gpt-5",
      }).args;
      expect(args[args.indexOf("--model") + 1]).toBe("gpt-5");
    });
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

  it("declares stallSignatures for the observed cursor-agent reconnect phrases", () => {
    expect(cursorAdapter.stallSignatures).toBeDefined();
    expect(Array.isArray(cursorAdapter.stallSignatures)).toBe(true);
    const sigs = cursorAdapter.stallSignatures!;
    expect(sigs.length).toBe(3);

    const connectLost =
      "Connection lost, reconnecting to https://agentn.global.api5.cursor.sh (attempt 1)...";
    const retry = "Retry attempt 1...";
    const retriable = "RetriableError: Connection stalled";

    // All three verbatim lines must match.
    expect(sigs[0].test(connectLost)).toBe(true);
    expect(sigs[1].test(retry)).toBe(true);
    expect(sigs[2].test(retriable)).toBe(true);
  });

  it("does NOT match benign lines that contain similar words", () => {
    expect(cursorAdapter.stallSignatures).toBeDefined();
    const sigs = cursorAdapter.stallSignatures!;

    const benign1 = "Reconnecting the debugger to the test runner";
    const benign2 = "  see docs: retry attempt limits";

    const allMatch = (line: string) => sigs.some((s) => s.test(line));
    expect(allMatch(benign1)).toBe(false);
    expect(allMatch(benign2)).toBe(false);
  });
});
