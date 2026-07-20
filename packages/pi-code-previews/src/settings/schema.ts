import * as Schema from "effect/Schema";
import { ALL_CODE_PREVIEW_TOOLS } from "../tools/names";
import {
  DIFF_BACKGROUND_INTENSITIES,
  DIFF_WORD_EMPHASES,
  PATH_ICON_MODES,
  TOOL_CALL_BACKGROUND_MODES,
} from "./schema-constants";

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

const PersistedFields = {
  shikiTheme: Schema.optional(Schema.String),
  diffIntensity: Schema.optional(DiffBackgroundIntensitySchema),
  wordEmphasis: Schema.optional(DiffWordEmphasisSchema),
  toolCallBackground: Schema.optional(Schema.Union([ToolCallBackgroundModeSchema, Schema.Boolean])),
  toolCallTiming: Schema.optional(Schema.Boolean),
  readCollapsedLines: Schema.optional(PositiveIntegerSchema),
  readContentPreview: Schema.optional(Schema.Boolean),
  writeContentPreview: Schema.optional(Schema.Boolean),
  writeCollapsedLines: Schema.optional(PositiveIntegerSchema),
  editDiffPreview: Schema.optional(Schema.Boolean),
  editCollapsedLines: Schema.optional(EditCollapsedLinesSchema),
  grepCollapsedLines: Schema.optional(PositiveIntegerSchema),
  grepResultPreview: Schema.optional(Schema.Boolean),
  findResultPreview: Schema.optional(Schema.Boolean),
  lsResultPreview: Schema.optional(Schema.Boolean),
  pathListCollapsedLines: Schema.optional(PositiveIntegerSchema),
  readLineNumbers: Schema.optional(Schema.Boolean),
  bashResultPreview: Schema.optional(Schema.Boolean),
  bashWarnings: Schema.optional(Schema.Boolean),
  syntaxHighlighting: Schema.optional(Schema.Boolean),
  secretWarnings: Schema.optional(Schema.Boolean),
  pathIcons: Schema.optional(PathIconModeSchema),
  tools: Schema.optional(Schema.Union([CodePreviewToolsSchema, Schema.String])),
} as const;

/** Current raw settings object, decoded field-by-field so one invalid sibling cannot erase others. */
export const PersistedCodePreviewSettingsSchema = Schema.Struct(PersistedFields);
export const NestedCodePreviewSettingsDocumentSchema = Schema.Struct({
  codePreview: Schema.optional(PersistedCodePreviewSettingsSchema),
});
/** Legacy prefixed documents remain forward compatible; owned fields are extracted before decoding. */
export const LegacyCodePreviewSettingsDocumentSchema = Schema.Record(Schema.String, Schema.Unknown);

type SchemaSettings = typeof CodePreviewSettingsSchema.Type;
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
export type CodePreviewSettings = Omit<Mutable<SchemaSettings>, "tools"> & {
  tools: Array<(typeof CodePreviewToolNameSchema)["Type"]>;
};
export type DiffBackgroundIntensity = typeof DiffBackgroundIntensitySchema.Type;
export type DiffWordEmphasis = typeof DiffWordEmphasisSchema.Type;
export type ToolCallBackgroundMode = typeof ToolCallBackgroundModeSchema.Type;
export type PathIconMode = typeof PathIconModeSchema.Type;
