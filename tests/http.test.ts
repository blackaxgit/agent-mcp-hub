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

describe("security hardening", () => {
  it("rejects non-loopback Origin with 403 (DNS-rebinding guard)", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { origin: "http://evil.example.com" },
    });
    expect(res.status).toBe(403);
  });

  it("allows loopback Origins", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "GET",
      headers: { origin: "http://localhost:3000" },
    });
    // Passes the origin gate and reaches the method check instead of 403.
    expect(res.status).toBe(405);
  });

  it("requires the bearer token when MCP_TOKEN is set (timing-safe compare)", async () => {
    process.env.MCP_TOKEN = "s3cret";
    try {
      const missing = await fetch(`${baseUrl}/mcp`, { method: "POST" });
      expect(missing.status).toBe(401);

      const wrong = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { authorization: "Bearer nope" },
      });
      expect(wrong.status).toBe(401);

      // Same length as the expected header but different value: the constant-time
      // compare must still reject rather than short-circuit on length.
      const wrongSameLength = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { authorization: "Bearer XXXXXX" },
      });
      expect(wrongSameLength.status).toBe(401);

      const client = new Client({ name: "http-test-auth", version: "0.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
          requestInit: { headers: { authorization: "Bearer s3cret" } },
        }),
      );
      const res = await client.callTool({ name: "ping", arguments: {} });
      expect((res.content as Array<{ type: string; text: string }>)[0].text).toBe("pong");
      await client.close();
    } finally {
      delete process.env.MCP_TOKEN;
    }
  });

  it("rejects a request whose port is already bound (listen error propagates)", async () => {
    const other = await startHttpServer(0);
    try {
      const { port } = other.address() as AddressInfo;
      await expect(startHttpServer(port)).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      await new Promise((resolve) => other.close(resolve));
    }
  });

  it("honours MCP_ALLOWED_ORIGINS for non-loopback origins", async () => {
    process.env.MCP_ALLOWED_ORIGINS = "http://allowed.example.com";
    try {
      // Allowed non-loopback Origin passes the gate and reaches the method check.
      const allowed = await fetch(`${baseUrl}/mcp`, {
        method: "GET",
        headers: { origin: "http://allowed.example.com" },
      });
      expect(allowed.status).toBe(405);

      // A different non-loopback Origin is still blocked.
      const blocked = await fetch(`${baseUrl}/mcp`, {
        method: "GET",
        headers: { origin: "http://other.example.com" },
      });
      expect(blocked.status).toBe(403);

      // A malformed Origin header exercises the URL-parse catch and is blocked.
      const malformed = await fetch(`${baseUrl}/mcp`, {
        method: "GET",
        headers: { origin: "not-a-url" },
      });
      expect(malformed.status).toBe(403);
    } finally {
      delete process.env.MCP_ALLOWED_ORIGINS;
    }
  });
});
