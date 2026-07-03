#!/usr/bin/env node
import { startHttpServer } from "./httpServer.js";

const port = Number(process.env.PORT ?? 3919);
// Loopback by default; set HOST=0.0.0.0 explicitly (e.g. in a container) to expose.
const host = process.env.HOST ?? "127.0.0.1";

startHttpServer(port, host)
  .then(() => {
    console.error(
      `agent-mcp-hub streamable HTTP server listening on ${host}:${port} (POST /mcp, GET /healthz)`,
    );
  })
  .catch((err: unknown) => {
    console.error("agent-mcp-hub fatal:", err);
    process.exit(1);
  });
