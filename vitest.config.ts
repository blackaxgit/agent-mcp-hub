import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Excluded from coverage with justification:
      // - index.ts: thin `#!/usr/bin/env node` bootstrap entrypoint
      //   (read env → call start fn → log → process.exit). Its behaviour is
      //   exercised by the stdio e2e smoke test (tests/e2e.test.ts), but v8
      //   in-process instrumentation cannot count a spawned subprocess.
      // - types.ts: type-only declarations, no runtime code.
      exclude: ["src/index.ts", "src/types.ts"],
      reporter: ["text", "text-summary", "html"],
      thresholds: { statements: 97, branches: 97, functions: 97, lines: 97 },
    },
  },
});
