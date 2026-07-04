import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Excluded from coverage with justification:
      // - index.ts / http.ts: thin `#!/usr/bin/env node` bootstrap entrypoints
      //   (read env → call start fn → log → process.exit). Their behaviour is
      //   exercised by the stdio e2e smoke and the httpServer integration tests,
      //   but v8 in-process instrumentation cannot count a spawned subprocess.
      // - types.ts: type-only declarations, no runtime code.
      exclude: ["src/index.ts", "src/http.ts", "src/types.ts"],
      reporter: ["text", "text-summary", "html"],
      thresholds: { statements: 97, branches: 97, functions: 97, lines: 97 },
    },
  },
});
