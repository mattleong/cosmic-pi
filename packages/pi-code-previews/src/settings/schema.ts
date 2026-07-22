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

export const PositiveIntegerSchema = Schema.Number.check(
  Schema.isFinite(),
  Schema.isInt(),
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);

export const EditCollapsedLinesSchema = Schema.Union([
  PositiveIntegerSchema,
  Schema.Literal("all"),
]);
export const CodePreviewToolsSchema = Schema.Array(CodePreviewToolNameSchema);

export const CodePreviewSettingsSchema = Schema.Struct({
  shikiTheme: Schema.String,
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
export type DiffBackgroundIntensity = typeof DiffBackgroundIntensitySchema.Type;
export type DiffWordEmphasis = typeof DiffWordEmphasisSchema.Type;
export type ToolCallBackgroundMode = typeof ToolCallBackgroundModeSchema.Type;
export type PathIconMode = typeof PathIconModeSchema.Type;
export type CodePreviewEditableSettingId = keyof CodePreviewSettings | "resetToDefaults";

export function parseToolCallBackgroundMode(value: unknown): ToolCallBackgroundMode | undefined {
  if (typeof value === "boolean") return value ? "on" : "off";
  if (typeof value !== "string") return undefined;

  const normalized = value.toLowerCase();
  if (isToolCallBackgroundMode(normalized)) return normalized;
  if (normalized === "1" || normalized === "true" || normalized === "yes") return "on";
  if (normalized === "0" || normalized === "false" || normalized === "no") return "off";
  return undefined;
}

export function isToolCallBackgroundMode(value: unknown): value is ToolCallBackgroundMode {
  return (
    typeof value === "string" && (TOOL_CALL_BACKGROUND_MODES as readonly string[]).includes(value)
  );
}
