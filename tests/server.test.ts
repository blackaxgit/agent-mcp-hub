import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Exec } from "../src/exec.js";
import { allAdapters } from "../src/registry.js";
import { buildServer } from "../src/server.js";

async function connectedClient(exec: Exec) {
  const server = buildServer(allAdapters(), exec);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
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
    expect(names).toEqual(["codex", "cursor", "list_agents", "opencode", "ping", "run_all"]);
  });

  it("runs an agent tool through exec with the adapter invocation", async () => {
    const exec: Exec = vi.fn(async () => ({ stdout: "done\n", stderr: "", exitCode: 0 }));
    const client = await connectedClient(exec);
    const res = await client.callTool({ name: "codex", arguments: { prompt: "hello", model: "o3" } });
    expect(exec).toHaveBeenCalledWith(
      "codex",
      ["exec", "--skip-git-repo-check", "--model", "o3", "-"],
      { cwd: undefined, timeoutMs: undefined, input: "hello" },
    );
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toBe("done");
  });

  it("returns isError with stderr on non-zero exit", async () => {
    const exec: Exec = vi.fn(async () => ({ stdout: "", stderr: "auth required", exitCode: 2 }));
    const client = await connectedClient(exec);
    const res = await client.callTool({ name: "cursor", arguments: { prompt: "x" } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("exit 2");
    expect(textOf(res)).toContain("auth required");
  });

  it("returns isError when exec rejects with a spawn failure", async () => {
    const exec: Exec = vi.fn(async () => {
      throw new Error('Failed to start "opencode": ENOENT. Is it installed and on PATH?');
    });
    const client = await connectedClient(exec);
    const res = await client.callTool({ name: "opencode", arguments: { prompt: "x" } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("Is it installed");
  });

  it("returns isError with the timeout message when exec times out", async () => {
    const exec: Exec = vi.fn(async () => {
      throw new Error('"cursor-agent" timed out after 50ms');
    });
    const client = await connectedClient(exec);
    const res = await client.callTool({ name: "cursor", arguments: { prompt: "x", timeoutMs: 50 } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("timed out after 50ms");
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
    ]);
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
    expect(text).toContain("not logged in");
    expect(text).toContain("## opencode (ok)");
    expect(res.isError).toBeFalsy();
  });

  it("starts all agents before any finishes and forwards options", async () => {
    let started = 0;
    const resolvers: Array<(r: { stdout: string; stderr: string; exitCode: number | null }) => void> = [];
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
    await vi.waitFor(() => expect(started).toBe(3));
    for (const resolve of resolvers) resolve({ stdout: "ok\n", stderr: "", exitCode: 0 });
    const res = await pending;
    expect(exec).toHaveBeenCalledWith("codex", ["exec", "--skip-git-repo-check", "-"], {
      cwd: "/tmp",
      timeoutMs: 1234,
      input: "p",
    });
    expect(textOf(res)).toContain("## codex (ok)");
  });
});
