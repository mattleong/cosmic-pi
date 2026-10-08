import { bundledThemes } from "shiki";
import * as Schema from "effect/Schema";
import { ALL_CODE_PREVIEW_TOOLS, type CodePreviewToolName } from "../tools/names";

export const DIFF_BACKGROUND_INTENSITIES = ["off", "subtle", "medium"] as const;
export const DIFF_WORD_EMPHASES = ["all", "smart", "off"] as const;
export const TOOL_CALL_BACKGROUND_MODES = ["on", "border", "off"] as const;
export const TOOL_CALL_COLLAPSED_STYLES = ["preview", "compact"] as const;
export const PATH_ICON_MODES = ["unicode", "nerd", "off"] as const;

const PositiveIntegerSchema = Schema.Int.check(Schema.isGreaterThan(0));

export const CodePreviewSettingsSchema = Schema.Struct({
  shikiTheme: Schema.Literals(Object.keys(bundledThemes)),
  diffIntensity: Schema.Literals(DIFF_BACKGROUND_INTENSITIES),
  wordEmphasis: Schema.Literals(DIFF_WORD_EMPHASES),
  toolCallBackground: Schema.Literals(TOOL_CALL_BACKGROUND_MODES),
  toolCallCollapsedStyle: Schema.Literals(TOOL_CALL_COLLAPSED_STYLES),
  toolCallTiming: Schema.Boolean,
  readCollapsedLines: PositiveIntegerSchema,
  readContentPreview: Schema.Boolean,
  writeContentPreview: Schema.Boolean,
  writeCollapsedLines: PositiveIntegerSchema,
  editDiffPreview: Schema.Boolean,
  editCollapsedLines: Schema.Union([PositiveIntegerSchema, Schema.Literal("all")]),
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
  pathIcons: Schema.Literals(PATH_ICON_MODES),
  tools: Schema.Array(Schema.Literals(ALL_CODE_PREVIEW_TOOLS)),
});

type SchemaSettings = typeof CodePreviewSettingsSchema.Type;
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
export type CodePreviewSettings = Omit<Mutable<SchemaSettings>, "tools"> & {
  tools: CodePreviewToolName[];
};
export type DiffWordEmphasis = SchemaSettings["wordEmphasis"];
export type ToolCallBackgroundMode = SchemaSettings["toolCallBackground"];
export type ToolCallCollapsedStyle = SchemaSettings["toolCallCollapsedStyle"];
export type PathIconMode = SchemaSettings["pathIcons"];
/** Settings edited by value; the tool selection has its own submenu. */
export type CodePreviewEditableSettingId =
  | Exclude<keyof CodePreviewSettings, "tools">
  | "resetToDefaults";

export const CODE_PREVIEW_SETTING_KEYS = Object.freeze(
  // SAFETY: The authoritative struct fields and CodePreviewSettings are derived from the same schema.
  Object.keys(CodePreviewSettingsSchema.fields) as (keyof CodePreviewSettings)[],
);
