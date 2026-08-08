import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { defaultsFromEnvironment } from "./defaults";
import type { CodePreviewSettings } from "./schema";

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

const ENVIRONMENT_KEYS = [
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
  return Object.freeze(
    Object.fromEntries(
      Object.entries(PERFORMANCE_ENVIRONMENT_KEYS).map(([field, key]) => [
        field,
        parsePositiveInteger(environment[key]) ??
          defaultCodePreviewPerformanceConfig[field as keyof CodePreviewPerformanceConfig],
      ]),
    ) as unknown as CodePreviewPerformanceConfig,
  );
}

export function publishCodePreviewEnvironmentProjection(
  config: CodePreviewPerformanceConfig,
  tools: string | undefined,
): void {
  codePreviewPerformanceConfig = Object.freeze({ ...config });
  codePreviewToolsEnvironmentValue = tools;
}

export interface CodePreviewEnvironmentShape {
  readonly values: CodePreviewEnvironment;
  readonly defaults: CodePreviewSettings;
  readonly performance: CodePreviewPerformanceConfig;
}

export class CodePreviewEnvironmentService extends Context.Service<
  CodePreviewEnvironmentService,
  CodePreviewEnvironmentShape
>()("pi-code-previews/config/env/CodePreviewEnvironmentService") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const values = yield* loadCodePreviewEnvironment;
      const service = CodePreviewEnvironmentService.of({
        values,
        defaults: Object.freeze(defaultsFromEnvironment(values)),
        performance: performanceConfigFromEnvironment(values),
      });
      publishCodePreviewEnvironmentProjection(service.performance, values.CODE_PREVIEW_TOOLS);
      return service;
    }),
  );

  static readonly layerFrom = (environment: Readonly<Record<string, string>>) =>
    this.layer.pipe(
      Layer.provide(
        Layer.succeed(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: environment })),
      ),
    );
}
