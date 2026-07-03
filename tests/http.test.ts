import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttpServer } from "../src/httpServer.js";

let httpServer: Server;
let baseUrl: string;

beforeAll(async () => {
  httpServer = await startHttpServer(0);
  const { port } = httpServer.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise((resolve) => httpServer.close(resolve));
});

describe("streamable HTTP transport", () => {
  it("serves MCP tool calls over POST /mcp", async () => {
    const client = new Client({ name: "http-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
    const res = await client.callTool({ name: "ping", arguments: {} });
    expect((res.content as Array<{ type: string; text: string }>)[0].text).toBe("pong");
    await client.close();
  });

  it("responds ok on GET /healthz", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("rejects GET /mcp (stateless mode is POST-only)", async () => {
    const res = await fetch(`${baseUrl}/mcp`);
    expect(res.status).toBe(405);
  });

  it("returns 404 for unknown paths", async () => {
    const res = await fetch(`${baseUrl}/nope`);
    expect(res.status).toBe(404);
  });
});
