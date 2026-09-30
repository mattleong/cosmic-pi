import { ALL_CODE_PREVIEW_TOOLS } from "../tools/names";
import type { CodePreviewSettings, CodePreviewStartupSettings } from "./schema";

const defaults: CodePreviewSettings = {
  shikiTheme: "dark-plus",
  diffIntensity: "subtle",
  wordEmphasis: "all",
  toolCallBackground: "on",
  toolCallCollapsedStyle: "preview",
  toolCallTiming: true,
  readCollapsedLines: 10,
  readContentPreview: true,
  writeContentPreview: true,
  writeCollapsedLines: 10,
  editDiffPreview: true,
  editCollapsedLines: 160,
  grepCollapsedLines: 15,
  grepResultPreview: true,
  findResultPreview: true,
  lsResultPreview: true,
  pathListCollapsedLines: 20,
  readLineNumbers: true,
  bashResultPreview: true,
  bashWarnings: true,
  syntaxHighlighting: true,
  secretWarnings: true,
  pathIcons: "unicode",
  tools: [...ALL_CODE_PREVIEW_TOOLS],
};
Object.freeze(defaults.tools);
export const defaultCodePreviewSettings = Object.freeze(defaults);

/** Startup opt-ins default off; every unknown or failed read also resolves to these values. */
export const defaultCodePreviewStartupSettings: CodePreviewStartupSettings = Object.freeze({
  nativeMcpPreviews: false,
});

const performanceDefaults = {
  asyncRenderChars: 8_000,
  maxHighlightChars: 80_000,
  cacheLimit: 192,
  cacheCharLimit: 4_000_000,
  contentLanguageDetectionChars: 50_000,
  diffWrapRows: 3,
  secretScanChars: 200_000,
  maxWriteDiffBytes: 200_000,
  maxWriteDiffChangedLineCells: 1_000_000,
};
export type CodePreviewPerformanceConfig = Readonly<typeof performanceDefaults>;
export const defaultCodePreviewPerformanceConfig = Object.freeze(performanceDefaults);
