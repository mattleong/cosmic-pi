import { bundledThemes } from "shiki";
import * as Schema from "effect/Schema";
import { parsePositiveInteger } from "../config/env";
import {
  isCodePreviewToolName,
  parseCodePreviewTools,
  type CodePreviewToolName,
} from "../tools/names";
import {
  CodePreviewToolsSchema,
  DIFF_BACKGROUND_INTENSITIES,
  DIFF_WORD_EMPHASES,
  DiffBackgroundIntensitySchema,
  DiffWordEmphasisSchema,
  EditCollapsedLinesSchema,
  PATH_ICON_MODES,
  PathIconModeSchema,
  PositiveIntegerSchema,
  ToolCallBackgroundModeSchema,
  isToolCallBackgroundMode,
  type CodePreviewSettings,
  type DiffBackgroundIntensity,
  type DiffWordEmphasis,
  type PathIconMode,
} from "./schema";

export type CodePreviewSettingDescriptor<K extends keyof CodePreviewSettings> = {
  readonly schema: Schema.Decoder<unknown>;
  normalize(value: unknown, fallback: CodePreviewSettings[K]): CodePreviewSettings[K];
  update(next: CodePreviewSettings, current: CodePreviewSettings, value: string): void;
};

type CodePreviewSettingDescriptors = {
  [K in keyof CodePreviewSettings]: CodePreviewSettingDescriptor<K>;
};

type BooleanSettingKey = {
  [K in keyof CodePreviewSettings]: CodePreviewSettings[K] extends boolean ? K : never;
}[keyof CodePreviewSettings];

type NumberSettingKey = {
  [K in keyof CodePreviewSettings]: CodePreviewSettings[K] extends number ? K : never;
}[keyof CodePreviewSettings];

function validatedSetting<K extends keyof CodePreviewSettings>(
  key: K,
  schema: Schema.Decoder<CodePreviewSettings[K]>,
  isValid: (value: unknown) => value is CodePreviewSettings[K],
): CodePreviewSettingDescriptor<K> {
  return {
    schema,
    normalize: (value, fallback) => (isValid(value) ? value : fallback),
    update: (next, _current, value) => {
      if (isValid(value)) next[key] = value;
    },
  };
}

function booleanSetting<K extends BooleanSettingKey>(key: K): CodePreviewSettingDescriptor<K> {
  return {
    schema: Schema.Boolean as Schema.Decoder<CodePreviewSettings[K]>,
    normalize: (value) => value as CodePreviewSettings[K],
    update: (next, _current, value) => {
      next[key] = (value === "on") as CodePreviewSettings[K];
    },
  };
}

function positiveIntegerSetting<K extends NumberSettingKey>(
  key: K,
): CodePreviewSettingDescriptor<K> {
  return {
    schema: PositiveIntegerSchema as Schema.Decoder<CodePreviewSettings[K]>,
    normalize: (value) => value as CodePreviewSettings[K],
    update: (next, current, value) => {
      next[key] = coerceStringNumber(value, current[key] as number) as CodePreviewSettings[K];
    },
  };
}

export const CODE_PREVIEW_SETTING_DEFINITIONS = {
  shikiTheme: validatedSetting("shikiTheme", Schema.String, isBundledThemeName),
  diffIntensity: validatedSetting(
    "diffIntensity",
    DiffBackgroundIntensitySchema,
    isDiffBackgroundIntensity,
  ),
  wordEmphasis: validatedSetting("wordEmphasis", DiffWordEmphasisSchema, isDiffWordEmphasis),
  toolCallBackground: validatedSetting(
    "toolCallBackground",
    ToolCallBackgroundModeSchema,
    isToolCallBackgroundMode,
  ),
  toolCallTiming: booleanSetting("toolCallTiming"),
  readCollapsedLines: positiveIntegerSetting("readCollapsedLines"),
  readContentPreview: booleanSetting("readContentPreview"),
  writeContentPreview: booleanSetting("writeContentPreview"),
  writeCollapsedLines: positiveIntegerSetting("writeCollapsedLines"),
  editDiffPreview: booleanSetting("editDiffPreview"),
  editCollapsedLines: {
    schema: EditCollapsedLinesSchema,
    normalize: (value) => value as CodePreviewSettings["editCollapsedLines"],
    update: (next, current, value) => {
      next.editCollapsedLines =
        value === "all"
          ? "all"
          : coerceStringNumber(
              value,
              typeof current.editCollapsedLines === "number" ? current.editCollapsedLines : 100,
            );
    },
  },
  grepCollapsedLines: positiveIntegerSetting("grepCollapsedLines"),
  grepResultPreview: booleanSetting("grepResultPreview"),
  findResultPreview: booleanSetting("findResultPreview"),
  lsResultPreview: booleanSetting("lsResultPreview"),
  pathListCollapsedLines: positiveIntegerSetting("pathListCollapsedLines"),
  readLineNumbers: booleanSetting("readLineNumbers"),
  bashResultPreview: booleanSetting("bashResultPreview"),
  bashWarnings: booleanSetting("bashWarnings"),
  syntaxHighlighting: booleanSetting("syntaxHighlighting"),
  secretWarnings: booleanSetting("secretWarnings"),
  pathIcons: validatedSetting("pathIcons", PathIconModeSchema, isPathIconMode),
  tools: {
    schema: CodePreviewToolsSchema,
    normalize: coerceTools,
    update: (next, current, value) => {
      next.tools = coerceTools(value, current.tools);
    },
  },
} as const satisfies CodePreviewSettingDescriptors;

export const CODE_PREVIEW_SETTING_KEYS = Object.keys(
  CODE_PREVIEW_SETTING_DEFINITIONS,
) as readonly (keyof CodePreviewSettings)[];

export function getSettingDefinition(
  id: string,
): CodePreviewSettingDescriptor<keyof CodePreviewSettings> | undefined {
  return Object.hasOwn(CODE_PREVIEW_SETTING_DEFINITIONS, id)
    ? CODE_PREVIEW_SETTING_DEFINITIONS[id as keyof CodePreviewSettings]
    : undefined;
}

function coerceStringNumber(value: string, fallback: number): number {
  return parsePositiveInteger(value) ?? fallback;
}

function coerceTools(value: unknown, fallback: CodePreviewToolName[]): CodePreviewToolName[] {
  if (typeof value === "string") return [...(parseCodePreviewTools(value) ?? fallback)];
  if (!Array.isArray(value)) return fallback;
  const tools = value.filter(
    (tool): tool is CodePreviewToolName => typeof tool === "string" && isCodePreviewToolName(tool),
  );
  return [...new Set(tools)];
}

export function isDiffBackgroundIntensity(value: unknown): value is DiffBackgroundIntensity {
  return isStringOption(DIFF_BACKGROUND_INTENSITIES, value);
}

export function isDiffWordEmphasis(value: unknown): value is DiffWordEmphasis {
  return isStringOption(DIFF_WORD_EMPHASES, value);
}

export function isPathIconMode(value: unknown): value is PathIconMode {
  return isStringOption(PATH_ICON_MODES, value);
}

function isStringOption<const T extends readonly string[]>(
  options: T,
  value: unknown,
): value is T[number] {
  return typeof value === "string" && (options as readonly string[]).includes(value);
}

export function isBundledThemeName(value: unknown): value is string {
  return typeof value === "string" && value in bundledThemes;
}
