import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

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
});
