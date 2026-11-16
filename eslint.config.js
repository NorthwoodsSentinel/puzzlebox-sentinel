// ESLint flat config. Lint runs with --max-warnings 0 (AGENTS.md "Lint has no warning tier").
// Out of scope: installs, coverage output and agent scratch space (AGENTS.md "Build output is never a gate target").
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { globalIgnores } from "eslint/config";

export default tseslint.config(
  globalIgnores(["**/node_modules/", "coverage/", ".scratch/"]),
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: { project: ["./tsconfig.json"], tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
);
