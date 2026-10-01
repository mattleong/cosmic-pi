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

function parseToolCallBackgroundMode(
  value: string | undefined,
): ToolCallBackgroundMode | undefined {
  const normalized = value?.toLowerCase();
  if (normalized === "on" || normalized === "border" || normalized === "off") return normalized;
  if (normalized === "1" || normalized === "true" || normalized === "yes") return "on";
  if (normalized === "0" || normalized === "false" || normalized === "no") return "off";
  return undefined;
}

type EnvironmentSettingCandidate = string | number | boolean | undefined;
type EnvironmentSettingParser = (value: string | undefined) => EnvironmentSettingCandidate;
const raw: EnvironmentSettingParser = (value) => value;
const lower: EnvironmentSettingParser = (value) => value?.toLowerCase();

/** Every fallback comes from the canonical default object; the map only names and parses variables. */
const SETTINGS_ENVIRONMENT = {
  shikiTheme: ["CODE_PREVIEW_THEME", raw],
  diffIntensity: ["CODE_PREVIEW_DIFF_INTENSITY", lower],
  wordEmphasis: ["CODE_PREVIEW_WORD_EMPHASIS", lower],
  toolCallBackground: ["CODE_PREVIEW_TOOL_CALL_BACKGROUND", parseToolCallBackgroundMode],
  toolCallCollapsedStyle: ["CODE_PREVIEW_TOOL_CALL_COLLAPSED_STYLE", lower],
  toolCallTiming: ["CODE_PREVIEW_TOOL_CALL_TIMING", parseBoolean],
  readCollapsedLines: ["CODE_PREVIEW_READ_LINES", parsePositiveInteger],
  readContentPreview: ["CODE_PREVIEW_READ_CONTENT", parseBoolean],
  writeContentPreview: ["CODE_PREVIEW_WRITE_CONTENT", parseBoolean],
  writeCollapsedLines: ["CODE_PREVIEW_WRITE_LINES", parsePositiveInteger],
  editDiffPreview: ["CODE_PREVIEW_EDIT_DIFF", parseBoolean],
  editCollapsedLines: [
    "CODE_PREVIEW_EDIT_LINES",
    (value) => (value === "all" ? "all" : parsePositiveInteger(value)),
  ],
  grepCollapsedLines: ["CODE_PREVIEW_GREP_LINES", parsePositiveInteger],
  grepResultPreview: ["CODE_PREVIEW_GREP_RESULTS", parseBoolean],
  findResultPreview: ["CODE_PREVIEW_FIND_RESULTS", parseBoolean],
  lsResultPreview: ["CODE_PREVIEW_LS_RESULTS", parseBoolean],
  pathListCollapsedLines: ["CODE_PREVIEW_PATH_LIST_LINES", parsePositiveInteger],
  readLineNumbers: ["CODE_PREVIEW_READ_LINE_NUMBERS", parseBoolean],
  bashResultPreview: ["CODE_PREVIEW_BASH_RESULTS", parseBoolean],
  bashWarnings: ["CODE_PREVIEW_BASH_WARNINGS", parseBoolean],
  syntaxHighlighting: ["CODE_PREVIEW_SYNTAX", parseBoolean],
  secretWarnings: ["CODE_PREVIEW_SECRET_WARNINGS", parseBoolean],
  pathIcons: ["CODE_PREVIEW_PATH_ICONS", lower],
} as const satisfies {
  readonly [K in Exclude<keyof CodePreviewSettings, "tools">]: readonly [
    string,
    EnvironmentSettingParser,
  ];
};

/** Every fallback comes from the canonical default object; the map only names the variables. */
const PERFORMANCE_ENVIRONMENT = {
  asyncRenderChars: "CODE_PREVIEW_ASYNC_RENDER_CHARS",
  maxHighlightChars: "CODE_PREVIEW_MAX_HIGHLIGHT_CHARS",
  cacheLimit: "CODE_PREVIEW_CACHE_LIMIT",
  cacheCharLimit: "CODE_PREVIEW_CACHE_CHAR_LIMIT",
  contentLanguageDetectionChars: "CODE_PREVIEW_CONTENT_LANGUAGE_DETECTION_CHARS",
  diffWrapRows: "CODE_PREVIEW_DIFF_WRAP_ROWS",
  secretScanChars: "CODE_PREVIEW_SECRET_SCAN_CHARS",
  maxWriteDiffBytes: "CODE_PREVIEW_MAX_WRITE_DIFF_BYTES",
  maxWriteDiffChangedLineCells: "CODE_PREVIEW_MAX_WRITE_DIFF_CHANGED_LINE_CELLS",
} as const satisfies Record<keyof CodePreviewPerformanceConfig, string>;

type EnvironmentKey =
  | (typeof SETTINGS_ENVIRONMENT)[keyof typeof SETTINGS_ENVIRONMENT][0]
  | (typeof PERFORMANCE_ENVIRONMENT)[keyof typeof PERFORMANCE_ENVIRONMENT]
  | "CODE_PREVIEW_TOOLS";
export type CodePreviewEnvironment = Readonly<Record<EnvironmentKey, string | undefined>>;

const ENVIRONMENT_KEYS: readonly EnvironmentKey[] = [
  ...Object.values(SETTINGS_ENVIRONMENT).map(([name]) => name),
  ...Object.values(PERFORMANCE_ENVIRONMENT),
  "CODE_PREVIEW_TOOLS",
];

/** Decoded exactly once by the session environment Layer. */
export const loadCodePreviewEnvironment = Config.all(
  // SAFETY: ENVIRONMENT_KEYS enumerates every CodePreviewEnvironment key.
  Object.fromEntries(
    ENVIRONMENT_KEYS.map((key) => [key, Config.String(key).pipe(Config.withDefault(undefined))]),
  ) as { [K in EnvironmentKey]: Config.Config<string | undefined> },
).pipe(Effect.map((values): CodePreviewEnvironment => Object.freeze(values)));

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

export function defaultsFromEnvironment(environment: CodePreviewEnvironment): CodePreviewSettings {
  const settings = Object.fromEntries(
    Object.entries(SETTINGS_ENVIRONMENT).map(([key, [name, parse]]) => [
      key,
      // SAFETY: SETTINGS_ENVIRONMENT keys are CodePreviewSettings keys.
      environmentField(key as keyof CodePreviewSettings, parse(environment[name])),
    ]),
  );
  // SAFETY: SETTINGS_ENVIRONMENT covers every settings key except tools.
  return { ...settings, tools: [...defaultCodePreviewSettings.tools] } as CodePreviewSettings;
}

export let codePreviewPerformanceConfig = defaultCodePreviewPerformanceConfig;
export let codePreviewToolsEnvironmentValue: string | undefined;

export function performanceConfigFromEnvironment(
  environment: CodePreviewEnvironment,
): CodePreviewPerformanceConfig {
  // SAFETY: PERFORMANCE_ENVIRONMENT covers every performance key.
  return Object.freeze(
    Object.fromEntries(
      Object.entries(PERFORMANCE_ENVIRONMENT).map(([key, name]) => [
        key,
        parsePositiveInteger(environment[name]) ??
          defaultCodePreviewPerformanceConfig[key as keyof CodePreviewPerformanceConfig],
      ]),
    ),
  ) as CodePreviewPerformanceConfig;
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
      return CodePreviewEnvironmentService.of({
        defaults,
      });
    }),
  );

  static readonly layerFrom = (environment: Record<string, string | undefined>) =>
    this.layer.pipe(
      Layer.provide(
        Layer.succeed(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(environment)),
      ),
    );
}
