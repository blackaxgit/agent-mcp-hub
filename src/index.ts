#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { enabledAdapters } from "./registry.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const server = buildServer(enabledAdapters());
  await server.connect(new StdioServerTransport());
  // stdio server stays alive until the client closes the pipe
}

main().catch((err: unknown) => {
  console.error("agent-mcp-hub fatal:", err);
  process.exit(1);
});
