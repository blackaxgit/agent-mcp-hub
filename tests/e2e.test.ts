import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCommand } from "../src/exec.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const pkg = createRequire(import.meta.url)("../package.json") as { version: string };
const INITIALIZE_REQUEST =
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}\n';

describe("stdio entry smoke", () => {
  it("responds to an MCP initialize request over stdio", async () => {
    const result = await runCommand(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: ROOT,
      timeoutMs: 30_000,
      input: INITIALIZE_REQUEST,
    });
    expect(result.stdout).toContain('"agent-mcp-hub"');
    expect(result.stdout).toContain(`"${pkg.version}"`);
  });
});
