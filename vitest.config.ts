import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    setupFiles: ["./tests/setup-isolation.ts"],
    testTimeout: 10000,
    exclude: ["**/node_modules/**", "**/dist/**", "**/web/dist/**", "**/vendor/**", "**/.worktree/**"],
  },
});
