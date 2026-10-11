import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Retention tests force a collection; workers expose `gc` from startup rather than changing
    // V8 flags while running.
    execArgv: ["--expose-gc"],
  },
});
