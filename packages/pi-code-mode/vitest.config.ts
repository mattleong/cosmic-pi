import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only this package's own suite: the nested private runtime workspace package
    // (`runtime/`) runs its own vendored runtime suite from its own package directory.
    include: ["tests/**/*.test.ts"],
  },
});
