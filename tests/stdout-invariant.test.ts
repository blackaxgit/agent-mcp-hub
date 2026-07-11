import { describe, it, expect, beforeAll } from "vitest";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("stdio transport keeps stdout pure JSON-RPC", () => {
  beforeAll(() => {
    // Build fresh so the spawned dist/index.js reflects current src/.
    execSync("npm run build", { cwd: root, stdio: "inherit" });
  }, 120_000);

  it("emits only JSON-RPC on stdout in response to initialize", async () => {
    const child = spawn(process.execPath, [join(root, "dist", "index.js")], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));

    const initialize =
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "stdout-invariant-test", version: "0.0.0" },
        },
      }) + "\n";

    try {
      child.stdin.write(initialize);
      // Wait (bounded) for the initialize response to arrive on stdout.
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !stdout.includes('"id":1')) {
        await new Promise((r) => setTimeout(r, 50));
      }

      const lines = stdout.split("\n").filter((l) => l.trim() !== "");
      // Got at least one JSON-RPC response back.
      expect(lines.length).toBeGreaterThan(0);
      // Every non-empty stdout line must be valid JSON-RPC — a stray console.log
      // (non-JSON text) would make JSON.parse throw and fail this test.
      for (const line of lines) {
        const msg = JSON.parse(line);
        expect(msg.jsonrpc).toBe("2.0");
      }
      // stderr is captured but NOT required (diagnostics are allowed there).
      void stderr;
    } finally {
      child.kill("SIGKILL");
    }
  }, 20_000);
});
