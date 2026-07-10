import { describe, expect, it } from "vitest";
import { classifyFailure, normalize, stripAnsi } from "../src/failure.js";
import {
  AgentStalledError,
  InvalidCwdError,
  OutputLimitError,
  ServerBusyError,
  SpawnError,
  TimeoutError,
  type ExecResult,
} from "../src/exec.js";

describe("classifyFailure — invalid cwd", () => {
  const adapter = { name: "codex", loginCommand: "codex login" };

  // A missing cwd and a missing binary both surface as ENOENT from spawn. Reporting
  // the former as "not installed" sent us hunting a healthy CLI for hours.
  it("reports invalid_cwd, never not_installed", () => {
    const c = classifyFailure(adapter, { error: new InvalidCwdError("/nope/here") });
    expect(c.code).toBe("invalid_cwd");
    expect(c.code).not.toBe("not_installed");
  });

  it("names the offending path and does not blame PATH", () => {
    const c = classifyFailure(adapter, { error: new InvalidCwdError("/nope/here") });
    expect(c.message).toContain("/nope/here");
    expect(c.message).not.toMatch(/not found on PATH/i);
    expect(c.message).toMatch(/Fix:.*resolvable/i);
  });

  it("still classifies a genuine spawn failure as not_installed", () => {
    expect(classifyFailure(adapter, { error: new SpawnError("boom") }).code).toBe("not_installed");
  });
});

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

describe("auth precision (R10) — bare 'please run' is not auth", () => {
  it("does not classify a generic 'please run <cmd>' failure as not_authenticated", () => {
    const out = classifyFailure(codex, {
      result: res("Error: please run `terraform init` before plan", "", 1),
    });
    expect(out.code).toBe("tool_failure");
  });
});

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

  it("TimeoutError kind:'idle' -> hung/unreachable message that does NOT suggest raising the cap", () => {
    const c = classifyFailure(codex, {
      error: new TimeoutError("no output for 300000ms (idle)", 300_000, "idle"),
    });
    expect(c.code).toBe("timed_out");
    expect(c.message).toContain("codex");
    expect(c.message).toContain("no output");
    expect(c.message).toContain("300000");
    // Points at the hung/unreachable cause, not the cap.
    expect(c.message).toMatch(/hung|unreachable/);
    // Must NOT tell the user to raise the timeout — the cap is not the problem.
    expect(c.message).not.toMatch(/raise/i);
    expect(c.message).not.toContain("timeoutMs");
    expect(c.message).not.toContain("MCP_AGENT_TIMEOUT_MS");
  });

  it("TimeoutError kind:'total' -> total-cap message that still contains 'timed out' and says to raise the cap", () => {
    const c = classifyFailure(codex, {
      error: new TimeoutError("timed out after 1800000ms (total)", 1_800_000, "total"),
    });
    expect(c.code).toBe("timed_out");
    expect(c.message).toContain("codex");
    expect(c.message).toContain("timed out");
    expect(c.message).toContain("1800000");
    expect(c.message).toContain("total runtime cap");
    expect(c.message).toContain("timeoutMs");
    expect(c.message).toContain("MCP_AGENT_TIMEOUT_MS");
  });

  it("TimeoutError DEFAULT kind (no kind arg) behaves as 'total' — keeps 'timed out' + raise-the-cap wording", () => {
    const c = classifyFailure(codex, {
      error: new TimeoutError("timed out after 1800000ms", 1_800_000),
    });
    expect(c.code).toBe("timed_out");
    expect(c.message).toContain("timed out");
    expect(c.message).toContain("total runtime cap");
    expect(c.message).toContain("timeoutMs");
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

  it("neither result nor error supplied -> tool_failure with (no output) fallback", () => {
    const c = classifyFailure(codex, {});
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

describe("classifyFailure — cause/tail clipping & snippet sourcing", () => {
  it("clips a long cause line to <=160 chars with a trailing ellipsis", () => {
    // First non-empty stderr line is a primary auth phrase followed by a long run.
    const longLine = "not logged in: " + "a".repeat(300);
    const c = classifyFailure(cursor, { result: res(longLine, "", 1) });
    expect(c.code).toBe("not_authenticated");
    expect(c.message).toContain("not logged in");
    // Truncation marker present, and the tail past the cap was dropped.
    expect(c.message).toContain("…");
    expect(c.message).not.toContain("a".repeat(200));
    const causeLine = c.message.split("\n")[1];
    // 160 kept chars + the one-char ellipsis marker.
    expect(causeLine.length).toBeLessThanOrEqual(161);
    expect(causeLine.endsWith("…")).toBe(true);
  });

  it("leaves a short cause line unchanged (no ellipsis added)", () => {
    const c = classifyFailure(cursor, { result: res("not logged in", "", 1) });
    expect(c.code).toBe("not_authenticated");
    const causeLine = c.message.split("\n")[1];
    expect(causeLine).toBe("not logged in");
    expect(causeLine).not.toContain("…");
  });

  it("prefixes the tool_failure tail with an ellipsis when clipped", () => {
    const long = "z".repeat(2000);
    const c = classifyFailure(codex, { result: res(long, "", 2) });
    expect(c.code).toBe("tool_failure");
    const body = c.message.split("\n").slice(1).join("\n");
    expect(body.startsWith("…")).toBe(true);
    expect(body.length).toBeLessThanOrEqual(501);
  });

  it("draws the cause snippet from stdout when stderr is whitespace-only", () => {
    // stderr trims to empty, so causeSnippet must fall back to stdout.
    const c = classifyFailure(opencode, { result: res("   \n  ", "please log in via stdout", 1) });
    expect(c.code).toBe("not_authenticated");
    expect(c.message).toContain("please log in via stdout");
  });

  it("yields an empty cause (no crash) when the snippet source strips to nothing", () => {
    // stderr is pure ANSI: raw .trim() is non-empty (so it is chosen as the source),
    // but stripAnsi() reduces it to "", so no non-empty line is found -> "" fallback.
    // The auth phrase in stdout still drives classification.
    const c = classifyFailure(cursor, { result: res(`${ESC}[0m`, "not logged in", 1) });
    expect(c.code).toBe("not_authenticated");
    expect(c.message).toContain("cursor-agent login");
    expect(c.message).not.toContain(ESC);
    // Message stays well-formed: header, empty cause line, then remediation.
    const lines = c.message.split("\n");
    expect(lines[0]).toContain("not authenticated");
    expect(lines[1]).toBe("");
  });
});

describe("classifyFailure — non-Error throws & config/exit branches", () => {
  it("stringifies a plain-string throw into the tool_failure message", () => {
    const c = classifyFailure(codex, { error: "a plain string, not an Error" });
    expect(c.code).toBe("tool_failure");
    expect(c.message).toContain("a plain string, not an Error");
  });

  it("stringifies a non-Error object throw via String(error)", () => {
    const c = classifyFailure(codex, { error: { toString: () => "objecty failure" } });
    expect(c.code).toBe("tool_failure");
    expect(c.message).toContain("objecty failure");
  });

  it("not_configured for an adapter WITH apiKeyEnv names the env var", () => {
    const c = classifyFailure(codex, { result: res("no default model configured", "", 1) });
    expect(c.code).toBe("not_configured");
    expect(c.message).toContain("or set OPENAI_API_KEY");
  });

  it("not_configured for an adapter WITHOUT apiKeyEnv omits the 'or set' clause", () => {
    const c = classifyFailure(opencode, { result: res("no default model configured", "", 1) });
    expect(c.code).toBe("not_configured");
    expect(c.message).toContain("opencode auth login");
    expect(c.message).not.toContain("or set");
  });

  it("tool_failure with a null exitCode renders 'exit unknown'", () => {
    const c = classifyFailure(codex, { result: { stderr: "boom", stdout: "", exitCode: null } });
    expect(c.code).toBe("tool_failure");
    expect(c.message).toContain("exit unknown");
    expect(c.message).toContain("boom");
  });
});

describe("classifyFailure — false positives & precedence (R10)", () => {
  it("'insufficient_quota: billing' is NOT not_authenticated", () => {
    const c = classifyFailure(codex, {
      result: res("insufficient_quota: billing hard limit", "", 1),
    });
    expect(c.code).not.toBe("not_authenticated");
  });

  it("quota marker suppresses auth classification when both are present", () => {
    const c = classifyFailure(codex, {
      result: res("insufficient_quota: billing limit reached; please sign in", "", 1),
    });
    expect(c.code).toBe("tool_failure");
    expect(c.message).not.toContain("codex login");
  });

  it("bare 'unauthorized' (no primary auth phrase) is NOT not_authenticated", () => {
    const c = classifyFailure(codex, {
      result: res("unauthorized", "", 1),
    });
    expect(c.code).toBe("tool_failure");
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

describe("classifyFailure — mutation-killing message pins (R10)", () => {
  it("cursor not_authenticated pins agent name, 'not authenticated', login command, and cause snippet", () => {
    const c = classifyFailure(cursor, { result: res("Press any key to sign in", "", 1) });
    expect(c.code).toBe("not_authenticated");
    expect(c.message).toContain("cursor");
    expect(c.message).toContain("not authenticated");
    expect(c.message).toContain("cursor-agent login");
    expect(c.message).toContain("Press any key to sign in");
  });

  it("codex not_authenticated pins agent name, 'not authenticated', login command, OPENAI_API_KEY, and cause snippet", () => {
    const c = classifyFailure(codex, { result: res("Error: set OPENAI_API_KEY", "", 1) });
    expect(c.code).toBe("not_authenticated");
    expect(c.message).toContain("codex");
    expect(c.message).toContain("not authenticated");
    expect(c.message).toContain("codex login");
    expect(c.message).toContain("OPENAI_API_KEY");
    expect(c.message).toContain("set OPENAI_API_KEY");
  });

  it("not_configured for codex pins 'not configured', login command, and 'or set OPENAI_API_KEY'", () => {
    const c = classifyFailure(codex, { result: res("no default model configured", "", 1) });
    expect(c.code).toBe("not_configured");
    expect(c.message).toContain("not configured");
    expect(c.message).toContain("codex login");
    expect(c.message).toContain("or set OPENAI_API_KEY");
  });

  it("not_configured for opencode pins 'not configured' and login command but NOT 'or set'", () => {
    const c = classifyFailure(opencode, { result: res("no default model configured", "", 1) });
    expect(c.code).toBe("not_configured");
    expect(c.message).toContain("not configured");
    expect(c.message).toContain("opencode auth login");
    expect(c.message).not.toContain("or set");
  });

  it("TimeoutError pins 'timed out' and the exact ms value", () => {
    const c = classifyFailure(codex, { error: new TimeoutError("x timed out after 50ms", 50) });
    expect(c.code).toBe("timed_out");
    expect(c.message).toContain("timed out");
    expect(c.message).toContain("50ms");
  });

  it("OutputLimitError pins the exact maxOutputBytes and 'output limit exceeded'", () => {
    const c = classifyFailure(codex, {
      error: new OutputLimitError('"codex" exceeded output limit of 4096 bytes', 4096),
    });
    expect(c.code).toBe("output_limit");
    expect(c.message).toContain("4096");
    expect(c.message).toContain("output limit exceeded");
  });

  it("'insufficient_quota: billing' exit 1 is tool_failure with no auth remediation", () => {
    const c = classifyFailure(codex, {
      result: res("insufficient_quota: billing hard limit", "", 1),
    });
    expect(c.code).toBe("tool_failure");
    expect(c.message).not.toContain("codex login");
    expect(c.message).not.toContain("OPENAI_API_KEY");
  });

  it("bare 'HTTP 401 GET /x' is tool_failure with no auth remediation", () => {
    const c = classifyFailure(codex, { result: res("HTTP 401 GET /x", "", 1) });
    expect(c.code).toBe("tool_failure");
    expect(c.message).not.toContain("login");
    expect(c.message).not.toContain("OPENAI_API_KEY");
  });

  it("long cause line is clipped with ellipsis and bounded in length", () => {
    const longCause = "not logged in: " + "a".repeat(500);
    const c = classifyFailure(cursor, { result: res(longCause, "", 1) });
    expect(c.code).toBe("not_authenticated");
    expect(c.message).toContain("…");
    const causeLine = c.message.split("\n")[1];
    expect(causeLine.length).toBeLessThanOrEqual(161);
    expect(causeLine.endsWith("…")).toBe(true);
  });

  it("long stderr tail is clipped with leading ellipsis and bounded in length", () => {
    const longStderr = "x".repeat(2000);
    const c = classifyFailure(codex, { result: res(longStderr, "", 2) });
    expect(c.code).toBe("tool_failure");
    const body = c.message.split("\n").slice(1).join("\n");
    expect(body.startsWith("…")).toBe(true);
    expect(body.length).toBeLessThanOrEqual(501);
  });
});

describe("classifyFailure — AgentStalledError -> stream_stalled", () => {
  it("codes as stream_stalled, not timed_out or tool_failure", () => {
    const c = classifyFailure(codex, {
      error: new AgentStalledError(
        "stalled",
        "Connection lost, reconnecting to https://x.y (attempt 1)...",
        3,
      ),
    });
    expect(c.code).toBe("stream_stalled");
    expect(c.code).not.toBe("timed_out");
    expect(c.code).not.toBe("tool_failure");
  });

  it("names the agent and quotes the matched signature line", () => {
    const sig =
      "Connection lost, reconnecting to https://agentn.global.api5.cursor.sh (attempt 1)...";
    const c = classifyFailure(cursor, {
      error: new AgentStalledError("stalled", sig, 3),
    });
    expect(c.message).toContain("cursor");
    expect(c.message).toContain(sig);
  });

  it("says the agent cannot complete a run in this environment", () => {
    const c = classifyFailure(codex, {
      error: new AgentStalledError("stalled", "Retry attempt 1...", 2),
    });
    expect(c.message).toMatch(/cannot complete a run in this environment/i);
  });

  it("says to treat the agent as unavailable", () => {
    const c = classifyFailure(codex, {
      error: new AgentStalledError("stalled", "Retry attempt 1...", 2),
    });
    expect(c.message).toMatch(/treat.*unavailable/i);
    expect(c.message).toContain("unavailable");
  });

  it("does NOT suggest raising timeoutMs", () => {
    const c = classifyFailure(codex, {
      error: new AgentStalledError("stalled", "Retry attempt 1...", 2),
    });
    expect(c.message).not.toMatch(/raise .*timeoutMs/i);
    expect(c.message).not.toMatch(/raise.*timeout/i);
    expect(c.message).not.toContain("MCP_AGENT_TIMEOUT_MS");
  });

  it("matches BEFORE TimeoutError in precedence", () => {
    // AgentStalledError must be classified as stream_stalled, never as timed_out.
    const c = classifyFailure(codex, {
      error: new AgentStalledError("stalled", "Retry attempt 1...", 2),
    });
    expect(c.code).toBe("stream_stalled");
  });

  it("carries strikes count on the error", () => {
    const err = new AgentStalledError("stalled", "Retry attempt 1...", 5);
    expect(err.strikes).toBe(5);
    expect(err.signature).toBe("Retry attempt 1...");
    expect(err.code).toBe("stream_stalled");
    expect(err).toBeInstanceOf(AgentStalledError);
    expect(err).toBeInstanceOf(Error);
  });
});
