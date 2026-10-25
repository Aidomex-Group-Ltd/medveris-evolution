import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    fileParallelism: false,
    reporters: ["default"],
  },
});
