import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "node_modules/**"]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        console: "readonly",
        fetch: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        URL: "readonly"
      }
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_" }
      ]
    }
  }
);
