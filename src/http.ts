#!/usr/bin/env node
import { startHttpServer } from "./httpServer.js";

const port = Number(process.env.PORT ?? 3919);

startHttpServer(port)
  .then(() => {
    console.error(`agent-mcp-hub streamable HTTP server listening on :${port} (POST /mcp, GET /healthz)`);
  })
  .catch((err: unknown) => {
    console.error("agent-mcp-hub fatal:", err);
    process.exit(1);
  });
