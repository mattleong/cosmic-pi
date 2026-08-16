import * as Predicate from "effect/Predicate";

import { bundledThemes } from "shiki";
import * as Schema from "effect/Schema";
import { parsePositiveInteger } from "./env";
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
  normalize<Value>(value: Value, fallback: CodePreviewSettings[K]): CodePreviewSettings[K];
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
  isValid: <Value>(value: Value) => value is Value & CodePreviewSettings[K],
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
  // SAFETY: Boundary decoding validates the value before it is narrowed to this declared contract.
  return {
    schema: Schema.Boolean as Schema.Decoder<CodePreviewSettings[K]>,
    normalize: (value) => value as CodePreviewSettings[K],
    update: (next, _current, value) => {
      // SAFETY: Configuration decoding validates the persisted value before this typed access.
      next[key] = (value === "on") as CodePreviewSettings[K];
    },
  };
}

function positiveIntegerSetting<K extends NumberSettingKey>(
  key: K,
): CodePreviewSettingDescriptor<K> {
  // SAFETY: Boundary decoding validates the value before it is narrowed to this declared contract.
  return {
    schema: PositiveIntegerSchema as Schema.Decoder<CodePreviewSettings[K]>,
    normalize: (value) => value as CodePreviewSettings[K],
    update: (next, current, value) => {
      // SAFETY: Configuration decoding validates the persisted value before this typed access.
      next[key] = coerceStringNumber(value, current[key] as number) as CodePreviewSettings[K];
    },
  };
}

// SAFETY: Boundary decoding validates the value before it is narrowed to this declared contract.
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
    normalize: <Value>(value: Value) => Schema.decodeUnknownSync(EditCollapsedLinesSchema)(value),
    update: (next, current, value) => {
      next.editCollapsedLines =
        value === "all"
          ? "all"
          : coerceStringNumber(
              value,
              Predicate.isNumber(current.editCollapsedLines) ? current.editCollapsedLines : 100,
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

const codePreviewSettingKeys = (): readonly (keyof CodePreviewSettings)[] => {
  // SAFETY: CODE_PREVIEW_SETTING_DEFINITIONS satisfies the complete CodePreviewSettings key map.
  return Object.keys(CODE_PREVIEW_SETTING_DEFINITIONS) as readonly (keyof CodePreviewSettings)[];
};
export const CODE_PREVIEW_SETTING_KEYS = codePreviewSettingKeys();

export function getSettingDefinition(
  id: string,
): CodePreviewSettingDescriptor<keyof CodePreviewSettings> | undefined {
  if (!Object.hasOwn(CODE_PREVIEW_SETTING_DEFINITIONS, id)) return undefined;
  // SAFETY: The own-property check proves id is one of the complete settings-definition keys.
  const key = id as keyof CodePreviewSettings;
  const definition = CODE_PREVIEW_SETTING_DEFINITIONS[key];
  // SAFETY: The mapped descriptor contract couples every definition to its corresponding settings key.
  return definition as typeof definition & CodePreviewSettingDescriptor<keyof CodePreviewSettings>;
}

function coerceStringNumber(value: string, fallback: number): number {
  return parsePositiveInteger(value) ?? fallback;
}

function coerceTools<ValueInput>(
  value: ValueInput,
  fallback: CodePreviewToolName[],
): CodePreviewToolName[] {
  if (Predicate.isString(value)) return [...(parseCodePreviewTools(value) ?? fallback)];
  if (!Array.isArray(value)) return fallback;
  const tools = value.filter(
    (tool): tool is CodePreviewToolName => Predicate.isString(tool) && isCodePreviewToolName(tool),
  );
  return [...new Set(tools)];
}

export function isDiffBackgroundIntensity<ValueInput>(
  value: ValueInput,
): value is ValueInput & DiffBackgroundIntensity {
  return isStringOption(DIFF_BACKGROUND_INTENSITIES, value);
}

export function isDiffWordEmphasis<ValueInput>(
  value: ValueInput,
): value is ValueInput & DiffWordEmphasis {
  return isStringOption(DIFF_WORD_EMPHASES, value);
}

export function isPathIconMode<ValueInput>(value: ValueInput): value is ValueInput & PathIconMode {
  return isStringOption(PATH_ICON_MODES, value);
}

function isStringOption<const T extends readonly string[], ValueInput>(
  options: T,
  value: ValueInput,
): value is ValueInput & T[number] {
  // SAFETY: Configuration decoding validates the persisted value before this typed access.
  return Predicate.isString(value) && (options as readonly string[]).includes(value);
}

export function isBundledThemeName<ValueInput>(value: ValueInput): value is ValueInput & string {
  return Predicate.isString(value) && value in bundledThemes;
}
