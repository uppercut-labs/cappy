import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**", ".cappy/**"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ["**/test/**/*.ts", "tests/**/*.ts"],
    rules: {
      // Tests inspect parsed JSON documents.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
