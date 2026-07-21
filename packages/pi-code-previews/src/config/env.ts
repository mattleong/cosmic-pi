import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { environmentValue } from "../boundary/environment";

export function parsePositiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function parseBoolean(value: string | undefined): boolean | undefined {
  switch (value?.trim().toLowerCase()) {
    case "1":
    case "true":
    case "on":
    case "yes":
      return true;
    case "0":
    case "false":
    case "off":
    case "no":
      return false;
    default:
      return undefined;
  }
}

export function booleanEnv(name: string, fallback: boolean): boolean {
  return parseBoolean(environmentValue(name)) ?? fallback;
}

const ENVIRONMENT_KEYS = [
  "HOME",
  "CODE_PREVIEW_THEME",
  "CODE_PREVIEW_DIFF_INTENSITY",
  "CODE_PREVIEW_WORD_EMPHASIS",
  "CODE_PREVIEW_TOOL_CALL_BACKGROUND",
  "CODE_PREVIEW_TOOL_CALL_TIMING",
  "CODE_PREVIEW_READ_LINES",
  "CODE_PREVIEW_READ_CONTENT",
  "CODE_PREVIEW_WRITE_CONTENT",
  "CODE_PREVIEW_WRITE_LINES",
  "CODE_PREVIEW_EDIT_DIFF",
  "CODE_PREVIEW_EDIT_LINES",
  "CODE_PREVIEW_GREP_LINES",
  "CODE_PREVIEW_GREP_RESULTS",
  "CODE_PREVIEW_FIND_RESULTS",
  "CODE_PREVIEW_LS_RESULTS",
  "CODE_PREVIEW_PATH_LIST_LINES",
  "CODE_PREVIEW_READ_LINE_NUMBERS",
  "CODE_PREVIEW_BASH_RESULTS",
  "CODE_PREVIEW_BASH_WARNINGS",
  "CODE_PREVIEW_SYNTAX",
  "CODE_PREVIEW_SECRET_WARNINGS",
  "CODE_PREVIEW_PATH_ICONS",
  "CODE_PREVIEW_TOOLS",
  "CODE_PREVIEW_ASYNC_RENDER_CHARS",
  "CODE_PREVIEW_MAX_HIGHLIGHT_CHARS",
  "CODE_PREVIEW_CACHE_LIMIT",
  "CODE_PREVIEW_CACHE_CHAR_LIMIT",
  "CODE_PREVIEW_CONTENT_LANGUAGE_DETECTION_CHARS",
  "CODE_PREVIEW_DIFF_WRAP_ROWS",
  "CODE_PREVIEW_SECRET_SCAN_CHARS",
  "CODE_PREVIEW_MAX_WRITE_DIFF_BYTES",
  "CODE_PREVIEW_MAX_WRITE_DIFF_CHANGED_LINE_CELLS",
] as const;

export type CodePreviewEnvironment = Readonly<
  Record<(typeof ENVIRONMENT_KEYS)[number], string | undefined>
>;

const description = Config.all(
  Object.fromEntries(ENVIRONMENT_KEYS.map((key) => [key, Config.option(Config.string(key))])) as {
    [K in (typeof ENVIRONMENT_KEYS)[number]]: Config.Config<Option.Option<string>>;
  },
);

/** Decoded exactly once by the session environment Layer. */
export const loadCodePreviewEnvironment = description.pipe(
  Effect.map(
    (values) =>
      Object.freeze(
        Object.fromEntries(
          ENVIRONMENT_KEYS.map((key) => [key, Option.getOrUndefined(values[key])]),
        ),
      ) as CodePreviewEnvironment,
  ),
);

export interface CodePreviewPerformanceConfig {
  readonly asyncRenderChars: number;
  readonly maxHighlightChars: number;
  readonly cacheLimit: number;
  readonly cacheCharLimit: number;
  readonly contentLanguageDetectionChars: number;
  readonly diffWrapRows: number;
  readonly secretScanChars: number;
  readonly maxWriteDiffBytes: number;
  readonly maxWriteDiffChangedLineCells: number;
}

export const defaultCodePreviewPerformanceConfig: CodePreviewPerformanceConfig = Object.freeze({
  asyncRenderChars: 8_000,
  maxHighlightChars: 80_000,
  cacheLimit: 192,
  cacheCharLimit: 4_000_000,
  contentLanguageDetectionChars: 50_000,
  diffWrapRows: 3,
  secretScanChars: 200_000,
  maxWriteDiffBytes: 200_000,
  maxWriteDiffChangedLineCells: 1_000_000,
});

export let codePreviewPerformanceConfig = defaultCodePreviewPerformanceConfig;
export let codePreviewToolsEnvironmentValue: string | undefined;

export function performanceConfigFromEnvironment(
  environment: CodePreviewEnvironment,
): CodePreviewPerformanceConfig {
  const integer = (key: keyof CodePreviewEnvironment, fallback: number) =>
    parsePositiveInteger(environment[key]) ?? fallback;
  return Object.freeze({
    asyncRenderChars: integer("CODE_PREVIEW_ASYNC_RENDER_CHARS", 8_000),
    maxHighlightChars: integer("CODE_PREVIEW_MAX_HIGHLIGHT_CHARS", 80_000),
    cacheLimit: integer("CODE_PREVIEW_CACHE_LIMIT", 192),
    cacheCharLimit: integer("CODE_PREVIEW_CACHE_CHAR_LIMIT", 4_000_000),
    contentLanguageDetectionChars: integer("CODE_PREVIEW_CONTENT_LANGUAGE_DETECTION_CHARS", 50_000),
    diffWrapRows: integer("CODE_PREVIEW_DIFF_WRAP_ROWS", 3),
    secretScanChars: integer("CODE_PREVIEW_SECRET_SCAN_CHARS", 200_000),
    maxWriteDiffBytes: integer("CODE_PREVIEW_MAX_WRITE_DIFF_BYTES", 200_000),
    maxWriteDiffChangedLineCells: integer(
      "CODE_PREVIEW_MAX_WRITE_DIFF_CHANGED_LINE_CELLS",
      1_000_000,
    ),
  });
}

export function publishCodePreviewEnvironmentProjection(
  config: CodePreviewPerformanceConfig,
  tools: string | undefined,
): void {
  codePreviewPerformanceConfig = Object.freeze({ ...config });
  codePreviewToolsEnvironmentValue = tools;
}
