import type * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import type { McpToolSummary } from "./model.ts";

export const MCP_TOOL_SUMMARY_LIMITS = Object.freeze({ title: 128, description: 512 });

export interface McpSearchMetadata {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly annotations?: Schema.Json;
}
const normalizeWhitespace = (text: string): string => text.replace(/\s+/gu, " ").trim();
const isAnnotationObject = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value);
const annotationsOf = (metadata: McpSearchMetadata) =>
  isAnnotationObject(metadata.annotations) ? metadata.annotations : undefined;
export const annotationTitle = (metadata: McpSearchMetadata): string | undefined => {
  const title = annotationsOf(metadata)?.title;
  return Predicate.isString(title) && title.trim() !== "" ? title : undefined;
};

/** Bound by Unicode code points, never split a surrogate pair. */
export const limitCodePoints = (text: string, limit: number): string => {
  let count = 0;
  let end = 0;
  for (const point of text) {
    if (count++ === limit) break;
    end += point.length;
  }
  return text.slice(0, end);
};

type Mutable<Value> = { -readonly [Key in keyof Value]: Value[Key] };
type ToolSummaryProjection = Mutable<McpToolSummary>;

/**
 * The default tools.list/search contract. Identities stay exact. Titles prefer top-level
 * metadata over annotations.title. Description is the first nonempty paragraph with
 * normalized whitespace. Limits count Unicode code points; true truncation markers report
 * omitted title text, description text, or later nonempty paragraphs. No schemas, examples,
 * extensions, annotation defaults, or permission claims enter this projection.
 */
export const summarizeTool = (server: string, metadata: McpSearchMetadata): McpToolSummary => {
  const summary: ToolSummaryProjection = { server, name: metadata.name };
  const title = normalizeWhitespace(metadata.title ?? "") || annotationTitle(metadata);
  if (title !== undefined) {
    const normalized = normalizeWhitespace(title);
    summary.title = limitCodePoints(normalized, MCP_TOOL_SUMMARY_LIMITS.title);
    if (summary.title !== normalized) summary.titleTruncated = true;
  }
  const paragraphs = (metadata.description ?? "")
    .replace(/\r\n?|\u2028/gu, "\n")
    .split(/\n\s*\n|\u2029/u)
    .map(normalizeWhitespace)
    .filter((paragraph) => paragraph !== "");
  const paragraph = paragraphs[0];
  if (paragraph !== undefined) {
    summary.description = limitCodePoints(paragraph, MCP_TOOL_SUMMARY_LIMITS.description);
    if (paragraphs.length > 1 || summary.description !== paragraph)
      summary.descriptionTruncated = true;
  }
  const source = annotationsOf(metadata);
  const hints: Mutable<NonNullable<McpToolSummary["annotations"]>> = {};
  for (const key of [
    "readOnlyHint",
    "destructiveHint",
    "idempotentHint",
    "openWorldHint",
  ] as const) {
    const value = source?.[key];
    if (Predicate.isBoolean(value)) hints[key] = value;
  }
  if (Object.keys(hints).length > 0) summary.annotations = hints;
  return summary;
};
