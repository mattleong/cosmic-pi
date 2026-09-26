import { DEFAULT_CODE_MODE_CONFIG, type CodeModeConfig } from "../../src/config/schema.ts";
import type { CodeModeState } from "../../src/config/store.ts";

export const codeModeStateFixture = (
  config: Partial<CodeModeConfig> = {},
  overrides: Partial<CodeModeState> = {},
): CodeModeState => ({
  projectTrusted: true,
  available: true,
  config: { ...DEFAULT_CODE_MODE_CONFIG, ...config },
  provenance: {
    enabled: "default",
    timeoutMs: "default",
    maxToolCalls: "default",
    maxOutputBytes: "default",
    maxSourceBytes: "default",
    maxCumulativeChildOutputBytes: "default",
    catalogBudget: "default",
  },
  globalValues: {},
  projectValues: {},
  ...overrides,
});
