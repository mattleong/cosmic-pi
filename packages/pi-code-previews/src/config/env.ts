import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  defaultCodePreviewPerformanceConfig,
  defaultCodePreviewSettings,
  type CodePreviewPerformanceConfig,
} from "./defaults";
import {
  CodePreviewSettingsSchema,
  type CodePreviewSettings,
  type ToolCallBackgroundMode,
} from "./schema";

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

export function parseToolCallBackgroundMode(
  value: string | undefined,
): ToolCallBackgroundMode | undefined {
  const normalized = value?.toLowerCase();
  if (normalized === "on" || normalized === "border" || normalized === "off") return normalized;
  if (normalized === "1" || normalized === "true" || normalized === "yes") return "on";
  if (normalized === "0" || normalized === "false" || normalized === "no") return "off";
  return undefined;
}

const ENVIRONMENT_KEYS = [
  "CODE_PREVIEW_THEME",
  "CODE_PREVIEW_DIFF_INTENSITY",
  "CODE_PREVIEW_WORD_EMPHASIS",
  "CODE_PREVIEW_TOOL_CALL_BACKGROUND",
  "CODE_PREVIEW_TOOL_CALL_COLLAPSED_STYLE",
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

// SAFETY: Configuration decoding validates the persisted value before this typed access.
const description = Config.all(
  Object.fromEntries(ENVIRONMENT_KEYS.map((key) => [key, Config.option(Config.string(key))])) as {
    [K in (typeof ENVIRONMENT_KEYS)[number]]: Config.Config<Option.Option<string>>;
  },
);

/** Decoded exactly once by the session environment Layer. */
// SAFETY: Configuration decoding validates the persisted value before this typed access.
export const loadCodePreviewEnvironment = description.pipe(
  Effect.map((values) => {
    const entries = Object.fromEntries(
      ENVIRONMENT_KEYS.map((key) => [key, Option.getOrUndefined(values[key])]),
    );
    // SAFETY: ENVIRONMENT_KEYS enumerates every required key and each mapped value is string | undefined.
    return Object.freeze(entries) as CodePreviewEnvironment;
  }),
);

type EnvironmentSettingCandidate = string | number | boolean | undefined;

function environmentField<K extends keyof CodePreviewSettings>(
  key: K,
  candidate: EnvironmentSettingCandidate,
): CodePreviewSettings[K] {
  const decoded = Schema.decodeUnknownOption(CodePreviewSettingsSchema.fields[key])(candidate);
  // SAFETY: The selected authoritative field schema corresponds to the requested settings key.
  return Option.isSome(decoded)
    ? (decoded.value as CodePreviewSettings[K])
    : defaultCodePreviewSettings[key];
}

/** Every fallback comes from the canonical default object, never a repeated setting literal. */
export function defaultsFromEnvironment(environment: CodePreviewEnvironment): CodePreviewSettings {
  const value = (name: keyof CodePreviewEnvironment) => environment[name];
  const boolean = <K extends keyof CodePreviewSettings>(
    name: keyof CodePreviewEnvironment,
    key: K,
  ) => environmentField(key, parseBoolean(value(name)));
  const integer = <K extends keyof CodePreviewSettings>(
    name: keyof CodePreviewEnvironment,
    key: K,
  ) => environmentField(key, parsePositiveInteger(value(name)));
  const editLines = value("CODE_PREVIEW_EDIT_LINES");
  return {
    shikiTheme: environmentField("shikiTheme", value("CODE_PREVIEW_THEME")),
    diffIntensity: environmentField(
      "diffIntensity",
      value("CODE_PREVIEW_DIFF_INTENSITY")?.toLowerCase(),
    ),
    wordEmphasis: environmentField(
      "wordEmphasis",
      value("CODE_PREVIEW_WORD_EMPHASIS")?.toLowerCase(),
    ),
    toolCallBackground: environmentField(
      "toolCallBackground",
      parseToolCallBackgroundMode(value("CODE_PREVIEW_TOOL_CALL_BACKGROUND")),
    ),
    toolCallCollapsedStyle: environmentField(
      "toolCallCollapsedStyle",
      value("CODE_PREVIEW_TOOL_CALL_COLLAPSED_STYLE")?.toLowerCase(),
    ),
    toolCallTiming: boolean("CODE_PREVIEW_TOOL_CALL_TIMING", "toolCallTiming"),
    readCollapsedLines: integer("CODE_PREVIEW_READ_LINES", "readCollapsedLines"),
    readContentPreview: boolean("CODE_PREVIEW_READ_CONTENT", "readContentPreview"),
    writeContentPreview: boolean("CODE_PREVIEW_WRITE_CONTENT", "writeContentPreview"),
    writeCollapsedLines: integer("CODE_PREVIEW_WRITE_LINES", "writeCollapsedLines"),
    editDiffPreview: boolean("CODE_PREVIEW_EDIT_DIFF", "editDiffPreview"),
    editCollapsedLines: environmentField(
      "editCollapsedLines",
      editLines === "all" ? "all" : parsePositiveInteger(editLines),
    ),
    grepCollapsedLines: integer("CODE_PREVIEW_GREP_LINES", "grepCollapsedLines"),
    grepResultPreview: boolean("CODE_PREVIEW_GREP_RESULTS", "grepResultPreview"),
    findResultPreview: boolean("CODE_PREVIEW_FIND_RESULTS", "findResultPreview"),
    lsResultPreview: boolean("CODE_PREVIEW_LS_RESULTS", "lsResultPreview"),
    pathListCollapsedLines: integer("CODE_PREVIEW_PATH_LIST_LINES", "pathListCollapsedLines"),
    readLineNumbers: boolean("CODE_PREVIEW_READ_LINE_NUMBERS", "readLineNumbers"),
    bashResultPreview: boolean("CODE_PREVIEW_BASH_RESULTS", "bashResultPreview"),
    bashWarnings: boolean("CODE_PREVIEW_BASH_WARNINGS", "bashWarnings"),
    syntaxHighlighting: boolean("CODE_PREVIEW_SYNTAX", "syntaxHighlighting"),
    secretWarnings: boolean("CODE_PREVIEW_SECRET_WARNINGS", "secretWarnings"),
    pathIcons: environmentField("pathIcons", value("CODE_PREVIEW_PATH_ICONS")?.toLowerCase()),
    tools: [...defaultCodePreviewSettings.tools],
  };
}

export let codePreviewPerformanceConfig = defaultCodePreviewPerformanceConfig;
export let codePreviewToolsEnvironmentValue: string | undefined;

/** Every fallback comes from the canonical default object; the map only names the variables. */
const PERFORMANCE_ENVIRONMENT_KEYS: Readonly<
  Record<keyof CodePreviewPerformanceConfig, keyof CodePreviewEnvironment>
> = Object.freeze({
  asyncRenderChars: "CODE_PREVIEW_ASYNC_RENDER_CHARS",
  maxHighlightChars: "CODE_PREVIEW_MAX_HIGHLIGHT_CHARS",
  cacheLimit: "CODE_PREVIEW_CACHE_LIMIT",
  cacheCharLimit: "CODE_PREVIEW_CACHE_CHAR_LIMIT",
  contentLanguageDetectionChars: "CODE_PREVIEW_CONTENT_LANGUAGE_DETECTION_CHARS",
  diffWrapRows: "CODE_PREVIEW_DIFF_WRAP_ROWS",
  secretScanChars: "CODE_PREVIEW_SECRET_SCAN_CHARS",
  maxWriteDiffBytes: "CODE_PREVIEW_MAX_WRITE_DIFF_BYTES",
  maxWriteDiffChangedLineCells: "CODE_PREVIEW_MAX_WRITE_DIFF_CHANGED_LINE_CELLS",
});

export function performanceConfigFromEnvironment(
  environment: CodePreviewEnvironment,
): CodePreviewPerformanceConfig {
  const value = <Key extends keyof CodePreviewPerformanceConfig>(key: Key): number =>
    parsePositiveInteger(environment[PERFORMANCE_ENVIRONMENT_KEYS[key]]) ??
    defaultCodePreviewPerformanceConfig[key];
  return Object.freeze({
    asyncRenderChars: value("asyncRenderChars"),
    maxHighlightChars: value("maxHighlightChars"),
    cacheLimit: value("cacheLimit"),
    cacheCharLimit: value("cacheCharLimit"),
    contentLanguageDetectionChars: value("contentLanguageDetectionChars"),
    diffWrapRows: value("diffWrapRows"),
    secretScanChars: value("secretScanChars"),
    maxWriteDiffBytes: value("maxWriteDiffBytes"),
    maxWriteDiffChangedLineCells: value("maxWriteDiffChangedLineCells"),
  });
}

export function publishCodePreviewEnvironmentProjection(
  config: CodePreviewPerformanceConfig,
  tools: string | undefined,
): void {
  codePreviewPerformanceConfig = Object.freeze({ ...config });
  codePreviewToolsEnvironmentValue = tools;
}

export interface CodePreviewEnvironmentContract {
  readonly defaults: CodePreviewSettings;
}

export class CodePreviewEnvironmentService extends Context.Service<
  CodePreviewEnvironmentService,
  CodePreviewEnvironmentContract
>()("pi-code-previews/config/env/CodePreviewEnvironmentService") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const values = yield* loadCodePreviewEnvironment;
      const defaults = Object.freeze(defaultsFromEnvironment(values));
      const performance = performanceConfigFromEnvironment(values);
      publishCodePreviewEnvironmentProjection(performance, values.CODE_PREVIEW_TOOLS);
      return CodePreviewEnvironmentService.of({ defaults });
    }),
  );

  static readonly layerFrom = (environment: Record<string, string | undefined>) =>
    this.layer.pipe(
      Layer.provide(
        Layer.succeed(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(environment)),
      ),
    );
}
