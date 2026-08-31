import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_CODE_MODE_CONFIG, type CodeModeConfig } from "../../src/config/schema.ts";
import type { CodeModeState } from "../../src/config/store.ts";

export const extensionApiFixture = <Fixture extends object>(
  fixture: Fixture,
): Fixture & ExtensionAPI => {
  // SAFETY: Each test uses only the ExtensionAPI members explicitly implemented by its fixture.
  return fixture as Fixture & ExtensionAPI;
};

export const extensionContextFixture = <Fixture extends object>(
  fixture: Fixture,
): Fixture & ExtensionContext & ExtensionCommandContext => {
  // SAFETY: Each test uses only the host context members explicitly implemented by its fixture.
  return fixture as Fixture & ExtensionContext & ExtensionCommandContext;
};

export const opaqueHostFixture = <Value>(value: Value): never => {
  // SAFETY: Boundary tests supply every opaque host member exercised by the subject.
  return value as never;
};

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
