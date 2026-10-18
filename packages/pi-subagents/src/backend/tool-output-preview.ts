import { flow } from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const TOOL_PREVIEW_LINES = 7;
const TOOL_PREVIEW_CHARS = 1_000;

const TextPart = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });
const isTextPart = Schema.is(TextPart);
const Content = Schema.Union([Schema.String, Schema.Array(Schema.Unknown)]);
// The runtimes report a plain string, content parts, or an object carrying `content`.
const ToolOutput = Schema.Union([Content, Schema.Struct({ content: Content })]);
type ContentValue = typeof Content.Type;
type ToolOutputValue = typeof ToolOutput.Type;

const contentText = (content: ContentValue): string =>
  Schema.is(Schema.String)(content)
    ? content
    : content.flatMap((part) => (isTextPart(part) ? [part.text] : [])).join("\n");

const outputText = (output: ToolOutputValue): string =>
  Schema.is(Content)(output) ? contentText(output) : contentText(output.content);

const previewText = (text: string): Option.Option<string> => {
  const trimmed = text.trim();
  if (!trimmed) return Option.none();
  const lines = trimmed.split("\n");
  const preview = lines.slice(0, TOOL_PREVIEW_LINES).join("\n");
  const clipped = preview.length > TOOL_PREVIEW_CHARS || lines.length > TOOL_PREVIEW_LINES;
  return Option.some(clipped ? `${preview.slice(0, TOOL_PREVIEW_CHARS)}…` : preview);
};

/** The first lines of a tool's output for the fleet view, bounded before the run sanitizes it. */
export const toolOutputPreview = flow(
  Schema.decodeUnknownOption(ToolOutput),
  Option.map(outputText),
  Option.flatMap(previewText),
  Option.getOrUndefined,
);
