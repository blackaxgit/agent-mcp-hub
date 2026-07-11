import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["dist/", "coverage/", "node_modules/", "eslint.config.mjs"] },
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
