import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

describe("architecture constraints", () => {
  it("only exec.ts imports node:child_process (C1)", () => {
    const offenders = walk(SRC).filter(
      (file) => !file.endsWith("exec.ts") && readFileSync(file, "utf8").includes("child_process"),
    );
    expect(offenders).toEqual([]);
  });

  it("nothing writes to stdout outside the MCP transport (C5)", () => {
    const offenders = walk(SRC).filter((file) => {
      const source = readFileSync(file, "utf8");
      return source.includes("console.log(") || source.includes("process.stdout.write(");
    });
    expect(offenders).toEqual([]);
  });

  it("the hub opens no listening socket (C6)", () => {
    const forbidden = [
      "node:http",
      "node:https",
      "node:net",
      "node:http2",
      "node:tls",
      "node:dgram",
      "http",
      "https",
      "net",
      "http2",
      "tls",
      "dgram",
      "@modelcontextprotocol/sdk/server/streamableHttp.js",
    ];
    const offenders = walk(SRC).flatMap((file) => {
      const source = readFileSync(file, "utf8");
      // Match static import specifiers (`from "..."`, `import "..."`),
      // dynamic `import("...")`, and `require("...")` — all specifier-only,
      // so a URL inside a comment or string literal never false-positives.
      const specRe =
        /(?:from|import)\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)/g;
      const hits: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = specRe.exec(source)) !== null) {
        const specifier = m[1] ?? m[2] ?? m[3];
        if (forbidden.includes(specifier)) {
          hits.push(`${file}: imported "${specifier}"`);
        }
      }
      return hits;
    });
    expect(offenders).toEqual([]);
  });

  it("exactly one transport entrypoint (C7)", () => {
    const pkgPath = join(REPO_ROOT, "package.json");
    const pkg: { bin?: Record<string, string> } = JSON.parse(readFileSync(pkgPath, "utf8"));
    const binKeys = Object.keys(pkg.bin ?? {});
    expect(binKeys).toEqual(["agent-mcp-hub"]);

    const stillPresent = ["src/http.ts", "src/httpServer.ts"].filter((p) =>
      existsSync(join(REPO_ROOT, p)),
    );
    expect(stillPresent).toEqual([]);
  });
});
