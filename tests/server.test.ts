import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { SpawnError, TimeoutError, type Exec } from "../src/exec.js";
import { allAdapters, enabledAdapters } from "../src/registry.js";
import { buildServer } from "../src/server.js";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

async function connectedClient(exec: Exec) {
  const server = buildServer(allAdapters(), exec);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

type ElicitHandler = Parameters<Client["setRequestHandler"]>[1];

async function connectedClientWithElicit(
  exec: Exec,
  handler: ElicitHandler,
  clientName = "test-client",
) {
  const server = buildServer(allAdapters(), exec);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: clientName, version: "0.0.0" },
    { capabilities: { elicitation: {} } },
  );
  client.setRequestHandler(ElicitRequestSchema, handler);
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(res: Awaited<ReturnType<Client["callTool"]>>): string {
  return (res.content as Array<{ type: string; text: string }>).map((c) => c.text).join("\n");
}

const okExec: Exec = vi.fn(async () => ({ stdout: "agent says hi\n", stderr: "", exitCode: 0 }));

describe("buildServer", () => {
  it("responds to ping", async () => {
    const client = await connectedClient(okExec);
    const res = await client.callTool({ name: "ping", arguments: {} });
    expect(textOf(res)).toBe("pong");
  });

  it("exposes one tool per adapter plus ping and list_agents", async () => {
    const client = await connectedClient(okExec);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "claude",
      "codex",
      "cursor",
      "list_agents",
      "opencode",
      "ping",
      "run_all",
    ]);
  });

  it("runs an agent tool through exec with the adapter invocation", async () => {
    const exec: Exec = vi.fn(async () => ({ stdout: "done\n", stderr: "", exitCode: 0 }));
    const client = await connectedClient(exec);
    const res = await client.callTool({
      name: "codex",
      arguments: { prompt: "hello", model: "o3" },
    });
    expect(exec).toHaveBeenCalledWith(
      "codex",
      ["exec", "--skip-git-repo-check", "--model", "o3", "-"],
      { cwd: undefined, timeoutMs: undefined, input: "hello" },
    );
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toBe("done");
  });

  it("returns a text-only tool_failure with (exit N) and the output tail on non-zero exit", async () => {
    const exec: Exec = vi.fn(async () => ({ stdout: "", stderr: "boom", exitCode: 2 }));
    const client = await connectedClient(exec);
    const res = await client.callTool({ name: "cursor", arguments: { prompt: "x" } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("(exit 2)");
    expect(textOf(res)).toContain("boom");
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content.length).toBe(1);
    expect(content[0].type).toBe("text");
    expect(res.structuredContent).toBeUndefined();
  });

  it("classifies a cursor ANSI sign-in banner as not authenticated with a clean remediation", async () => {
    const banner = "\x1b[2K\x1b[1A Press any key to sign in...";
    const exec: Exec = vi.fn(async () => ({ stdout: "", stderr: banner, exitCode: 1 }));
    const client = await connectedClient(exec);
    const res = await client.callTool({ name: "cursor", arguments: { prompt: "x" } });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain("cursor-agent login");
    expect(text).toContain("not authenticated");
    expect(text.includes("\x1b")).toBe(false);
    expect((res.content as unknown[]).length).toBe(1);
    expect(res.structuredContent).toBeUndefined();
  });

  it("classifies a SpawnError as not installed with an install hint", async () => {
    const exec: Exec = vi.fn(async () => {
      throw new SpawnError('Failed to start "opencode": ENOENT. Is it installed and on PATH?');
    });
    const client = await connectedClient(exec);
    const res = await client.callTool({ name: "opencode", arguments: { prompt: "x" } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("not installed");
    expect(res.structuredContent).toBeUndefined();
  });

  it("classifies a TimeoutError as timed_out and states the ms", async () => {
    const exec: Exec = vi.fn(async () => {
      throw new TimeoutError('"cursor-agent" timed out after 50ms', 50);
    });
    const client = await connectedClient(exec);
    const res = await client.callTool({
      name: "cursor",
      arguments: { prompt: "x", timeoutMs: 50 },
    });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain("timed out");
    expect(text).toContain("50");
    expect(res.structuredContent).toBeUndefined();
  });

  it("returns isError for opencode prompts starting with '-' without calling exec", async () => {
    const exec: Exec = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const client = await connectedClient(exec);
    const res = await client.callTool({ name: "opencode", arguments: { prompt: "--help me" } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("prompts that start with '-'");
    expect(exec).not.toHaveBeenCalled();
  });

  it("list_agents reports availability per adapter", async () => {
    const exec: Exec = vi.fn(async (binary: string) => {
      if (binary === "codex") return { stdout: "1.0\n", stderr: "", exitCode: 0 };
      throw new Error("missing");
    });
    const client = await connectedClient(exec);
    const res = await client.callTool({ name: "list_agents", arguments: {} });
    const parsed = JSON.parse(textOf(res)) as Array<{ name: string; available: boolean }>;
    expect(parsed).toEqual([
      { name: "codex", available: true },
      { name: "cursor", available: false },
      { name: "opencode", available: false },
      { name: "claude", available: false },
    ]);
  });

  it("advertises the package.json version to clients", async () => {
    const client = await connectedClient(okExec);
    const info = client.getServerVersion();
    expect(info?.version).toBe(pkg.version);
  });

  it("emits exactly one structured agent_run line to stderr with no prompt text", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const client = await connectedClient(okExec);
      await client.callTool({
        name: "codex",
        arguments: { prompt: "super-secret-prompt", cwd: "/work" },
      });
      const lines = errSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((line) => line.includes('"agent_run"'));
      expect(lines).toHaveLength(1);
      const record = JSON.parse(lines[0]) as {
        evt: string;
        agent: string;
        cwd: string | null;
        ms: number;
        exitCode?: number | null;
      };
      expect(record.evt).toBe("agent_run");
      expect(record.agent).toBe("codex");
      expect(record.cwd).toBe("/work");
      expect(typeof record.ms).toBe("number");
      expect(record.exitCode).toBe(0);
      expect(lines[0]).not.toContain("super-secret-prompt");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("exposes only the enabled agents when built from a filtered registry", async () => {
    const exec: Exec = vi.fn(async (binary: string) => ({
      stdout: `${binary} answer\n`,
      stderr: "",
      exitCode: 0,
    }));
    const server = buildServer(enabledAdapters("codex,opencode"), exec);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "codex",
      "list_agents",
      "opencode",
      "ping",
      "run_all",
    ]);

    const agents = await client.callTool({ name: "list_agents", arguments: {} });
    const parsed = JSON.parse(textOf(agents)) as Array<{ name: string; available: boolean }>;
    expect(parsed.map((a) => a.name)).toEqual(["codex", "opencode"]);

    (exec as ReturnType<typeof vi.fn>).mockClear();
    await client.callTool({ name: "run_all", arguments: { prompt: "compare" } });
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec).toHaveBeenCalledWith("codex", expect.anything(), expect.anything());
    expect(exec).toHaveBeenCalledWith("opencode", expect.anything(), expect.anything());
  });
});

describe("run_all", () => {
  it("fans out to every adapter and labels ok/failed per agent", async () => {
    const exec: Exec = vi.fn(async (binary: string) => {
      if (binary === "cursor-agent") return { stdout: "", stderr: "not logged in", exitCode: 1 };
      return { stdout: `${binary} answer\n`, stderr: "", exitCode: 0 };
    });
    const client = await connectedClient(exec);
    const res = await client.callTool({ name: "run_all", arguments: { prompt: "compare" } });
    const text = textOf(res);
    expect(text).toContain("## codex (ok)");
    expect(text).toContain("codex answer");
    expect(text).toContain("## cursor (failed)");
    expect(text).toContain("cursor-agent login");
    expect(text).toContain("## opencode (ok)");
    expect(text).toContain("## claude (ok)");
    expect(text).toContain("claude answer");
    expect(res.isError).toBeFalsy();
  });

  it("labels an agent whose exec REJECTS as (failed) with the classified message", async () => {
    const exec: Exec = vi.fn(async (binary: string) => {
      if (binary === "codex") throw new Error("boom-reject");
      return { stdout: `${binary} answer\n`, stderr: "", exitCode: 0 };
    });
    const client = await connectedClient(exec);
    const res = await client.callTool({ name: "run_all", arguments: { prompt: "compare" } });
    const text = textOf(res);
    expect(text).toContain("## codex (failed)");
    expect(text).toContain("boom-reject");
    expect(text).toContain("## cursor (ok)");
    expect(text).toContain("## opencode (ok)");
    expect(text).toContain("## claude (ok)");
    expect(res.isError).toBeFalsy();
  });

  it("starts all agents before any finishes and forwards options", async () => {
    let started = 0;
    const resolvers: Array<
      (r: { stdout: string; stderr: string; exitCode: number | null }) => void
    > = [];
    const exec: Exec = vi.fn((binary: string) => {
      started += 1;
      void binary;
      return new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolve) => {
        resolvers.push(resolve);
      });
    });
    const client = await connectedClient(exec);
    const pending = client.callTool({
      name: "run_all",
      arguments: { prompt: "p", cwd: "/tmp", timeoutMs: 1234 },
    });
    await vi.waitFor(() => expect(started).toBe(4));
    for (const resolve of resolvers) resolve({ stdout: "ok\n", stderr: "", exitCode: 0 });
    const res = await pending;
    expect(exec).toHaveBeenCalledWith("codex", ["exec", "--skip-git-repo-check", "-"], {
      cwd: "/tmp",
      timeoutMs: 1234,
      input: "p",
    });
    expect(exec).toHaveBeenCalledWith("cursor-agent", ["-p", "--output-format", "text"], {
      cwd: "/tmp",
      timeoutMs: 1234,
      input: "p",
    });
    expect(exec).toHaveBeenCalledWith("opencode", ["run", "p"], {
      cwd: "/tmp",
      timeoutMs: 1234,
      input: undefined,
    });
    expect(exec).toHaveBeenCalledWith("claude", ["-p", "--output-format", "text"], {
      cwd: "/tmp",
      timeoutMs: 1234,
      input: "p",
    });
    expect(textOf(res)).toContain("## codex (ok)");
    expect(textOf(res)).toContain("## cursor (ok)");
    expect(textOf(res)).toContain("## opencode (ok)");
    expect(textOf(res)).toContain("## claude (ok)");
  });

  it("forwards model to every adapter invocation", async () => {
    const exec: Exec = vi.fn(async (binary: string) => ({
      stdout: `${binary} answer\n`,
      stderr: "",
      exitCode: 0,
    }));
    const client = await connectedClient(exec);
    await client.callTool({
      name: "run_all",
      arguments: { prompt: "compare", model: "o3" },
    });
    expect(exec).toHaveBeenCalledWith(
      "codex",
      ["exec", "--skip-git-repo-check", "--model", "o3", "-"],
      { cwd: undefined, timeoutMs: undefined, input: "compare" },
    );
    expect(exec).toHaveBeenCalledWith(
      "cursor-agent",
      ["-p", "--output-format", "text", "--model", "o3"],
      { cwd: undefined, timeoutMs: undefined, input: "compare" },
    );
  });
});

// A2 / A4 — confirm-before-run gate (MCP elicitation). Env is restored with an
// explicit if/else per test (never assign =undefined) so a set MCP_CONFIRM does
// not leak into the other tests in the file.
async function withConfirmEnv(value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const prev = process.env.MCP_CONFIRM;
  if (value === undefined) delete process.env.MCP_CONFIRM;
  else process.env.MCP_CONFIRM = value;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.MCP_CONFIRM;
    else process.env.MCP_CONFIRM = prev;
  }
}

const acceptHandler: ElicitHandler = async () => ({ action: "accept", content: { confirm: true } });
const declineHandler: ElicitHandler = async () => ({ action: "decline" });

describe("confirm-before-run gate", () => {
  it("A2(a) MCP_CONFIRM=1 + accept → agent runs and the summary carries agent name + prompt", async () => {
    await withConfirmEnv("1", async () => {
      const exec: Exec = vi.fn(async () => ({ stdout: "done\n", stderr: "", exitCode: 0 }));
      let seen = "";
      const handler: ElicitHandler = async (req) => {
        seen = (req.params as { message: string }).message;
        return { action: "accept", content: { confirm: true } };
      };
      const client = await connectedClientWithElicit(exec, handler);
      const res = await client.callTool({ name: "codex", arguments: { prompt: "hello world" } });
      expect(exec).toHaveBeenCalledTimes(1);
      expect(res.isError).toBeFalsy();
      expect(textOf(res)).toBe("done");
      expect(seen).toContain("codex");
      expect(seen).toContain("hello world");
    });
  });

  it("A2(b) decline → exec NOT called, isError with cancelled-by-user wording", async () => {
    await withConfirmEnv("1", async () => {
      const exec: Exec = vi.fn(async () => ({ stdout: "done\n", stderr: "", exitCode: 0 }));
      const client = await connectedClientWithElicit(exec, declineHandler);
      const res = await client.callTool({ name: "codex", arguments: { prompt: "hello" } });
      expect(exec).not.toHaveBeenCalled();
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain("cancelled by user");
    });
  });

  it("A2(c) accept but confirm:false → treated as decline, not run", async () => {
    await withConfirmEnv("1", async () => {
      const exec: Exec = vi.fn(async () => ({ stdout: "done\n", stderr: "", exitCode: 0 }));
      const handler: ElicitHandler = async () => ({
        action: "accept",
        content: { confirm: false },
      });
      const client = await connectedClientWithElicit(exec, handler);
      const res = await client.callTool({ name: "codex", arguments: { prompt: "hello" } });
      expect(exec).not.toHaveBeenCalled();
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain("cancelled by user");
    });
  });

  it("A2(d) MCP_CONFIRM unset + elicit-capable client → runs without eliciting", async () => {
    await withConfirmEnv(undefined, async () => {
      const exec: Exec = vi.fn(async () => ({ stdout: "done\n", stderr: "", exitCode: 0 }));
      let fired = false;
      const handler: ElicitHandler = async () => {
        fired = true;
        return { action: "accept", content: { confirm: true } };
      };
      const client = await connectedClientWithElicit(exec, handler);
      const res = await client.callTool({ name: "codex", arguments: { prompt: "hello" } });
      expect(exec).toHaveBeenCalledTimes(1);
      expect(fired).toBe(false);
      expect(res.isError).toBeFalsy();
    });
  });

  it("A2(e) MCP_CONFIRM=1 + client WITHOUT elicitation capability → runs (degrade)", async () => {
    await withConfirmEnv("1", async () => {
      const exec: Exec = vi.fn(async () => ({ stdout: "done\n", stderr: "", exitCode: 0 }));
      const client = await connectedClient(exec);
      const res = await client.callTool({ name: "codex", arguments: { prompt: "hello" } });
      expect(exec).toHaveBeenCalledTimes(1);
      expect(res.isError).toBeFalsy();
    });
  });

  it("A2(f) run_all + accept → all agents run with exactly ONE elicit", async () => {
    await withConfirmEnv("1", async () => {
      const exec: Exec = vi.fn(async (binary: string) => ({
        stdout: `${binary} answer\n`,
        stderr: "",
        exitCode: 0,
      }));
      let fired = 0;
      const handler: ElicitHandler = async () => {
        fired += 1;
        return { action: "accept", content: { confirm: true } };
      };
      const client = await connectedClientWithElicit(exec, handler);
      const res = await client.callTool({ name: "run_all", arguments: { prompt: "compare" } });
      expect(exec).toHaveBeenCalledTimes(4);
      expect(fired).toBe(1);
      expect(res.isError).toBeFalsy();
    });
  });

  it("A2(f) run_all + decline → single cancelled result, nothing spawned", async () => {
    await withConfirmEnv("1", async () => {
      const exec: Exec = vi.fn(async () => ({ stdout: "x\n", stderr: "", exitCode: 0 }));
      const client = await connectedClientWithElicit(exec, declineHandler);
      const res = await client.callTool({ name: "run_all", arguments: { prompt: "compare" } });
      expect(exec).not.toHaveBeenCalled();
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain("cancelled by user");
    });
  });

  it("A2(g) handler throws → isError, exec NOT called (catch → cancelled)", async () => {
    await withConfirmEnv("1", async () => {
      const exec: Exec = vi.fn(async () => ({ stdout: "done\n", stderr: "", exitCode: 0 }));
      const handler: ElicitHandler = async () => {
        throw new Error("client dropped mid-confirm");
      };
      const client = await connectedClientWithElicit(exec, handler);
      const res = await client.callTool({ name: "codex", arguments: { prompt: "hello" } });
      expect(exec).not.toHaveBeenCalled();
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain("cancelled by user");
    });
  });
});

describe("confirm gate is client-agnostic (A4/E7)", () => {
  it("two clients with DIFFERENT clientInfo.name but identical elicitation cap both run on accept", async () => {
    await withConfirmEnv("1", async () => {
      const execA: Exec = vi.fn(async () => ({ stdout: "done\n", stderr: "", exitCode: 0 }));
      const execB: Exec = vi.fn(async () => ({ stdout: "done\n", stderr: "", exitCode: 0 }));
      const alpha = await connectedClientWithElicit(execA, acceptHandler, "ide-alpha");
      const beta = await connectedClientWithElicit(execB, acceptHandler, "ide-beta");
      const resA = await alpha.callTool({ name: "codex", arguments: { prompt: "hi" } });
      const resB = await beta.callTool({ name: "codex", arguments: { prompt: "hi" } });
      expect(execA).toHaveBeenCalledTimes(1);
      expect(execB).toHaveBeenCalledTimes(1);
      expect(resA.isError).toBeFalsy();
      expect(resB.isError).toBeFalsy();
    });
  });

  it("two clients with DIFFERENT clientInfo.name both cancel on decline", async () => {
    await withConfirmEnv("1", async () => {
      const execA: Exec = vi.fn(async () => ({ stdout: "done\n", stderr: "", exitCode: 0 }));
      const execB: Exec = vi.fn(async () => ({ stdout: "done\n", stderr: "", exitCode: 0 }));
      const alpha = await connectedClientWithElicit(execA, declineHandler, "ide-alpha");
      const beta = await connectedClientWithElicit(execB, declineHandler, "ide-beta");
      const resA = await alpha.callTool({ name: "codex", arguments: { prompt: "hi" } });
      const resB = await beta.callTool({ name: "codex", arguments: { prompt: "hi" } });
      expect(execA).not.toHaveBeenCalled();
      expect(execB).not.toHaveBeenCalled();
      expect(resA.isError).toBe(true);
      expect(resB.isError).toBe(true);
    });
  });

  it("A4 secondary: no product/IDE literal gates the confirm (source smoke)", () => {
    const PRODUCT = /\b(claude|cursor|codex|vscode|windsurf|zed|continue)\b/i;
    // confirm.ts is the pure gate helper — must be product-agnostic end to end.
    const confirmSrc = readFileSync(new URL("../src/confirm.ts", import.meta.url), "utf8");
    expect(confirmSrc).not.toMatch(PRODUCT);
    // ...and the confirmOrCancel function body in server.ts (adapter names elsewhere
    // in server.ts are legitimate tool registration, so scan only this function).
    const serverSrc = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    const start = serverSrc.indexOf("async function confirmOrCancel");
    const body = serverSrc.slice(start, serverSrc.indexOf("\n  }", start));
    expect(start).toBeGreaterThan(-1);
    expect(body).not.toMatch(PRODUCT);
  });
});
