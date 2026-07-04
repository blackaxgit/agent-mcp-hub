import { describe, expect, it } from "vitest";
import { classifyFailure, normalize, stripAnsi } from "../src/failure.js";
import {
  OutputLimitError,
  ServerBusyError,
  SpawnError,
  TimeoutError,
  type ExecResult,
} from "../src/exec.js";

const cursor = { name: "cursor", loginCommand: "cursor-agent login", apiKeyEnv: "CURSOR_API_KEY" };
const codex = { name: "codex", loginCommand: "codex login", apiKeyEnv: "OPENAI_API_KEY" };
const opencode = { name: "opencode", loginCommand: "opencode auth login" };
const claude = { name: "claude", loginCommand: "claude", apiKeyEnv: "ANTHROPIC_API_KEY" };

/** Build an ExecResult for the non-zero-exit (result) branch. */
const res = (stderr: string, stdout: string, exitCode: number): ExecResult => ({
  stderr,
  stdout,
  exitCode,
});

const ESC = "";

describe("stripAnsi", () => {
  it("removes a cursor-style sign-in banner's escape sequences", () => {
    const banner = `${ESC}[2K${ESC}[36mPress any key to sign in${ESC}[0m`;
    const out = stripAnsi(banner);
    expect(out).toBe("Press any key to sign in");
    expect(out).not.toContain(ESC);
    expect(out).not.toContain("[36m");
  });

  it("collapses carriage-return spinner runs", () => {
    expect(stripAnsi("working\r\r\rdone")).not.toContain("\r");
  });

  it("is harmless on a truncated lone ESC at the buffer end", () => {
    const out = stripAnsi(`ok${ESC}`);
    // Lone ESC is stripped or left harmless; never crashes.
    expect(out.startsWith("ok")).toBe(true);
  });
});

describe("normalize", () => {
  it("lowercases after stripping ANSI", () => {
    expect(normalize(`${ESC}[31mERR${ESC}[0m`)).toBe("err");
    expect(normalize("Not Logged In")).toBe("not logged in");
  });
});

describe("classifyFailure — error branch (by type)", () => {
  it("SpawnError -> not_installed", () => {
    const c = classifyFailure(codex, {
      error: new SpawnError('Failed to start "codex": ENOENT. Is it installed and on PATH?'),
    });
    expect(c.code).toBe("not_installed");
    expect(c.message).toContain("codex");
  });

  it("ServerBusyError -> server_busy", () => {
    const c = classifyFailure(codex, { error: new ServerBusyError() });
    expect(c.code).toBe("server_busy");
  });

  it("TimeoutError -> timed_out and states the ms", () => {
    const c = classifyFailure(codex, { error: new TimeoutError("x timed out after 50ms", 50) });
    expect(c.code).toBe("timed_out");
    expect(c.message).toContain("50");
  });

  it("OutputLimitError -> output_limit and states the byte cap", () => {
    const c = classifyFailure(codex, {
      error: new OutputLimitError('"codex" exceeded output limit of 4096 bytes', 4096),
    });
    expect(c.code).toBe("output_limit");
    expect(c.message).toContain("4096");
  });

  it("any other Error -> tool_failure containing the message", () => {
    const c = classifyFailure(codex, { error: new Error("boom") });
    expect(c.code).toBe("tool_failure");
    expect(c.message).toContain("boom");
  });

  it("opencode dash-guard Error -> tool_failure keeping the guard text", () => {
    const c = classifyFailure(opencode, {
      error: new Error("opencode rejects prompts that start with '-'"),
    });
    expect(c.code).toBe("tool_failure");
    expect(c.message).toContain("prompts that start with '-'");
  });

  it("strips ANSI from an unknown error message", () => {
    const c = classifyFailure(codex, { error: new Error(`${ESC}[31mboom${ESC}[0m`) });
    expect(c.code).toBe("tool_failure");
    expect(c.message).not.toContain(ESC);
    expect(c.message).toContain("boom");
  });
});

describe("classifyFailure — result branch (exit != 0)", () => {
  it("cursor sign-in banner -> not_authenticated with the login command + cause", () => {
    const banner = `${ESC}[2KPress any key to sign in${ESC}[0m`;
    const c = classifyFailure(cursor, { result: res(banner, "", 1) });
    expect(c.code).toBe("not_authenticated");
    expect(c.message).toContain("cursor-agent login");
    expect(c.message).toContain("CURSOR_API_KEY");
    expect(c.message).toContain("Press any key to sign in");
    expect(c.message).not.toContain(ESC);
  });

  it("codex 'set OPENAI_API_KEY' -> not_authenticated", () => {
    const c = classifyFailure(codex, { result: res("Error: set OPENAI_API_KEY", "", 1) });
    expect(c.code).toBe("not_authenticated");
    expect(c.message).toContain("codex login");
  });

  it("opencode 'no credentials' -> not_authenticated", () => {
    const c = classifyFailure(opencode, { result: res("no credentials found", "", 1) });
    expect(c.code).toBe("not_authenticated");
    expect(c.message).toContain("opencode auth login");
  });

  it("claude 'Invalid API key · Please run /login' -> not_authenticated", () => {
    const c = classifyFailure(claude, {
      result: res("Invalid API key · Please run /login", "", 1),
    });
    expect(c.code).toBe("not_authenticated");
    expect(c.message).toContain("claude");
    expect(c.message).toContain("ANTHROPIC_API_KEY");
  });

  it("'no default model' -> not_configured", () => {
    const c = classifyFailure(codex, { result: res("no default model configured", "", 1) });
    expect(c.code).toBe("not_configured");
    expect(c.message).toContain("codex login");
  });

  it("'rate limit' -> server_busy", () => {
    const c = classifyFailure(codex, { result: res("rate limit exceeded", "", 1) });
    expect(c.code).toBe("server_busy");
  });

  it("'429' -> server_busy", () => {
    const c = classifyFailure(codex, { result: res("HTTP 429 Too Many Requests", "", 1) });
    expect(c.code).toBe("server_busy");
  });

  it("generic 'boom' exit 2 -> tool_failure with (exit 2) and boom", () => {
    const c = classifyFailure(codex, { result: res("boom", "", 2) });
    expect(c.code).toBe("tool_failure");
    expect(c.message).toContain("(exit 2)");
    expect(c.message).toContain("boom");
  });

  it("empty output exit 3 -> tool_failure with (no output)", () => {
    const c = classifyFailure(codex, { result: res("", "", 3) });
    expect(c.code).toBe("tool_failure");
    expect(c.message).toContain("(no output)");
  });

  it("falls back to stdout when stderr is empty", () => {
    const c = classifyFailure(codex, { result: res("", "downstream boom", 2) });
    expect(c.code).toBe("tool_failure");
    expect(c.message).toContain("downstream boom");
  });

  it("trims a very long tail to <=500 chars with an ellipsis marker", () => {
    const long = "x".repeat(2000);
    const c = classifyFailure(codex, { result: res(long, "", 2) });
    expect(c.code).toBe("tool_failure");
    expect(c.message).toContain("…");
    // body after the header line must be bounded
    const body = c.message.split("\n").slice(1).join("\n");
    expect(body.length).toBeLessThanOrEqual(501);
  });
});

describe("classifyFailure — false positives & precedence (R10)", () => {
  it("'insufficient_quota: billing' is NOT not_authenticated", () => {
    const c = classifyFailure(codex, {
      result: res("insufficient_quota: billing hard limit", "", 1),
    });
    expect(c.code).not.toBe("not_authenticated");
  });

  it("bare 'HTTP 401 GET /x' (no primary phrase) is NOT not_authenticated", () => {
    const c = classifyFailure(codex, { result: res("HTTP 401 GET /x", "", 1) });
    expect(c.code).toBe("tool_failure");
  });

  it("'rate limit … please sign in' -> server_busy (busy wins over auth)", () => {
    const c = classifyFailure(cursor, {
      result: res("rate limit reached, please sign in later", "", 1),
    });
    expect(c.code).toBe("server_busy");
  });

  it("'not logged in … no default model' -> not_authenticated (auth before config)", () => {
    const c = classifyFailure(codex, {
      result: res("not logged in; also no default model", "", 1),
    });
    expect(c.code).toBe("not_authenticated");
  });

  it("quota phrase suppresses auth even with a primary phrase present", () => {
    const c = classifyFailure(codex, {
      result: res("invalid api key: insufficient_quota", "", 1),
    });
    expect(c.code).not.toBe("not_authenticated");
  });
});
