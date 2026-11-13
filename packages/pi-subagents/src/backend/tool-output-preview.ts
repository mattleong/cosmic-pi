import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { contentText } from "pi-cosmic-core/message-text";
import { indexOfFrom } from "pi-cosmic-core/text-scan";

const TOOL_PREVIEW_LINES = 7;
const TOOL_PREVIEW_CHARS = 1_000;

const Content = Schema.Union([Schema.String, Schema.Array(Schema.Unknown)]);
const isContent = Schema.is(Content);
// The runtimes report a plain string, content parts, or an object carrying `content`.
const ToolOutput = Schema.Union([Content, Schema.Struct({ content: Content })]);
type ToolOutputValue = typeof ToolOutput.Type;

const outputText = (output: ToolOutputValue): string =>
  isContent(output) ? contentText(output) : contentText(output.content);

// Where the preview's last line ends when more lines follow it, without splitting all the output.
const previewLinesEnd = (text: string): number | undefined => {
  let end = -1;
  for (let line = 0; line < TOOL_PREVIEW_LINES; line += 1) {
    end = indexOfFrom(text, "\n", end + 1);
    if (end === -1) return undefined;
  }
  return end;
};

/** Drops surrounding blank lines and trailing spaces but keeps the first line's indentation. */
const trimOutput = (text: string): string =>
  Fn.pipe(text, Str.replace(/^(?:[^\S\n]*\n)+/u, ""), Str.trimEnd);

const previewText = (text: string): Option.Option<string> => {
  const trimmed = trimOutput(text);
  if (!Str.isNonEmpty(Str.trim(trimmed))) return Option.none();
  const end = previewLinesEnd(trimmed);
  const preview = end === undefined ? trimmed : Fn.pipe(trimmed, Str.slice(0, end));
  const clipped = preview.length > TOOL_PREVIEW_CHARS || end !== undefined;
  return Option.some(clipped ? `${Fn.pipe(preview, Str.slice(0, TOOL_PREVIEW_CHARS))}…` : preview);
};

/** The first lines of a tool's output for Activity, bounded before the run sanitizes it. */
export const toolOutputPreview = Fn.flow(
  Schema.decodeUnknownOption(ToolOutput),
  Option.map(outputText),
  Option.flatMap(previewText),
  Option.getOrUndefined,
);
