import { bundledThemes } from "shiki";
import * as Schema from "effect/Schema";
import { ALL_CODE_PREVIEW_TOOLS } from "../tools/names";

export const DIFF_BACKGROUND_INTENSITIES = ["off", "subtle", "medium"] as const;
export const DIFF_WORD_EMPHASES = ["all", "smart", "off"] as const;
export const TOOL_CALL_BACKGROUND_MODES = ["on", "border", "off"] as const;
export const PATH_ICON_MODES = ["unicode", "nerd", "off"] as const;

export const DiffBackgroundIntensitySchema = Schema.Literals(DIFF_BACKGROUND_INTENSITIES);
export const DiffWordEmphasisSchema = Schema.Literals(DIFF_WORD_EMPHASES);
export const ToolCallBackgroundModeSchema = Schema.Literals(TOOL_CALL_BACKGROUND_MODES);
export const PathIconModeSchema = Schema.Literals(PATH_ICON_MODES);
export const CodePreviewToolNameSchema = Schema.Literals(ALL_CODE_PREVIEW_TOOLS);
export const BundledShikiThemeSchema = Schema.Literals(Object.keys(bundledThemes));

export const PositiveIntegerSchema = Schema.Int.check(Schema.isGreaterThan(0));

export const EditCollapsedLinesSchema = Schema.Union([
  PositiveIntegerSchema,
  Schema.Literal("all"),
]);
export const CodePreviewToolsSchema = Schema.Array(CodePreviewToolNameSchema);

export const CodePreviewSettingsSchema = Schema.Struct({
  shikiTheme: BundledShikiThemeSchema,
  diffIntensity: DiffBackgroundIntensitySchema,
  wordEmphasis: DiffWordEmphasisSchema,
  toolCallBackground: ToolCallBackgroundModeSchema,
  toolCallTiming: Schema.Boolean,
  readCollapsedLines: PositiveIntegerSchema,
  readContentPreview: Schema.Boolean,
  writeContentPreview: Schema.Boolean,
  writeCollapsedLines: PositiveIntegerSchema,
  editDiffPreview: Schema.Boolean,
  editCollapsedLines: EditCollapsedLinesSchema,
  grepCollapsedLines: PositiveIntegerSchema,
  grepResultPreview: Schema.Boolean,
  findResultPreview: Schema.Boolean,
  lsResultPreview: Schema.Boolean,
  pathListCollapsedLines: PositiveIntegerSchema,
  readLineNumbers: Schema.Boolean,
  bashResultPreview: Schema.Boolean,
  bashWarnings: Schema.Boolean,
  syntaxHighlighting: Schema.Boolean,
  secretWarnings: Schema.Boolean,
  pathIcons: PathIconModeSchema,
  tools: CodePreviewToolsSchema,
});

type SchemaSettings = typeof CodePreviewSettingsSchema.Type;
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
export type CodePreviewSettings = Omit<Mutable<SchemaSettings>, "tools"> & {
  tools: Array<(typeof CodePreviewToolNameSchema)["Type"]>;
};
export type DiffWordEmphasis = typeof DiffWordEmphasisSchema.Type;
export type ToolCallBackgroundMode = typeof ToolCallBackgroundModeSchema.Type;
export type PathIconMode = typeof PathIconModeSchema.Type;
export type CodePreviewEditableSettingId = keyof CodePreviewSettings | "resetToDefaults";

const codePreviewSettingKeys = (): readonly (keyof CodePreviewSettings)[] => {
  // SAFETY: The authoritative struct fields and CodePreviewSettings are derived from the same schema.
  return Object.keys(CodePreviewSettingsSchema.fields) as readonly (keyof CodePreviewSettings)[];
};

export const CODE_PREVIEW_SETTING_KEYS = Object.freeze(codePreviewSettingKeys());
