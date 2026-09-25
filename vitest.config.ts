import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["source"],
  },
  ssr: {
    resolve: {
      conditions: ["source"],
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "fixtures/*/test/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
  },
});
