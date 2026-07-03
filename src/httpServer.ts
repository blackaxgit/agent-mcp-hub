import { createServer, type Server } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { enabledAdapters } from "./registry.js";
import { buildServer } from "./server.js";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Browser requests carry an Origin header; absent Origin means a non-browser
 * client. Rejecting non-loopback origins blocks DNS-rebinding attacks against
 * an endpoint that can spawn coding agents.
 */
function isOriginAllowed(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  const extra = (process.env.MCP_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (extra.includes(origin)) return true;
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export async function startHttpServer(port: number, host = "127.0.0.1"): Promise<Server> {
  // Resolve enabled agents up front so an invalid MCP_AGENTS rejects the
  // returned promise (http.ts's .catch fatal path) before the port binds,
  // rather than surfacing per-request.
  const adapters = enabledAdapters();
  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    if (!isOriginAllowed(req.headers.origin)) {
      res.writeHead(403, { "content-type": "text/plain" }).end("forbidden origin");
      return;
    }
    if (req.method !== "POST") {
      res
        .writeHead(405, { "content-type": "application/json", allow: "POST" })
        .end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Method not allowed: stateless server accepts POST only" },
            id: null,
          }),
        );
      return;
    }
    const token = process.env.MCP_TOKEN;
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      res
        .writeHead(401, { "content-type": "text/plain", "www-authenticate": "Bearer" })
        .end("unauthorized");
      return;
    }
    try {
      // Stateless: a fresh server + transport per request, torn down with the response.
      const server = buildServer(adapters);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("agent-mcp-hub http error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain" }).end("internal error");
      }
    }
  });
  return await new Promise((resolve) => {
    httpServer.listen(port, host, () => resolve(httpServer));
  });
}
