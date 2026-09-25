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
    // Integration tests launch games, fake tools, and FFmpeg; allow for slow or heavily loaded hosts.
    testTimeout: 30_000,
    globalSetup: ["tests/global-setup.ts"],
  },
});
