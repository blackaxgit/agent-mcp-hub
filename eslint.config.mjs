import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  // `.claude/` holds tooling scratch space — notably `.claude/worktrees/<name>/`,
  // a full nested checkout created when an agent task runs in its own worktree.
  // Without this ignore eslint walks that copy and fails the gate with parser
  // errors about a tsconfig root it does not own.
  { ignores: ["dist/", "coverage/", "node_modules/", ".claude/", "eslint.config.mjs"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Type-checked rules limited to src (the code-execution surface where a
    // floating promise is a real bug). tsconfig.json only includes src, so the
    // project service can type these files; tests live outside it.
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-console": ["error", { allow: ["error", "warn"] }],
    },
  },
  eslintConfigPrettier,
);
