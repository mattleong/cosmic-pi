import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

const TOOL_PREVIEW_LINES = 7;
const TOOL_PREVIEW_CHARS = 1_000;

const TextPart = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });
const isTextPart = Schema.is(TextPart);
const Content = Schema.Union([Schema.String, Schema.Array(Schema.Unknown)]);
const isContent = Schema.is(Content);
// The runtimes report a plain string, content parts, or an object carrying `content`.
const ToolOutput = Schema.Union([Content, Schema.Struct({ content: Content })]);
type ContentValue = typeof Content.Type;
type ToolOutputValue = typeof ToolOutput.Type;

const contentText = (content: ContentValue): string =>
  Predicate.isString(content)
    ? content
    : Arr.join(
        Arr.filterMap(content, (part) =>
          isTextPart(part) ? Result.succeed(part.text) : Result.failVoid,
        ),
        "\n",
      );

const outputText = (output: ToolOutputValue): string =>
  isContent(output) ? contentText(output) : contentText(output.content);

const previewText = (text: string): Option.Option<string> => {
  const trimmed = Str.trim(text);
  if (!trimmed) return Option.none();
  const lines = Str.split(trimmed, "\n");
  const preview = Arr.join(lines.slice(0, TOOL_PREVIEW_LINES), "\n");
  const clipped = preview.length > TOOL_PREVIEW_CHARS || lines.length > TOOL_PREVIEW_LINES;
  return Option.some(clipped ? `${Fn.pipe(preview, Str.slice(0, TOOL_PREVIEW_CHARS))}…` : preview);
};

/** The first lines of a tool's output for the fleet view, bounded before the run sanitizes it. */
export const toolOutputPreview = Fn.flow(
  Schema.decodeUnknownOption(ToolOutput),
  Option.map(outputText),
  Option.flatMap(previewText),
  Option.getOrUndefined,
);
