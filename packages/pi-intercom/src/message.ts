import type { ExtensionAPI, MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { captureCodePreviewPresentationPolicy, renderCompactRow } from "pi-code-previews";
import { clipText } from "pi-cosmic-core/display";
import { indexOfFrom } from "pi-cosmic-core/text-scan";
import { stripTerminalControls } from "pi-cosmic-core/security";
import { sessionSubject } from "./tools/summary.ts";
import { clipToWidth } from "pi-cosmic-ui/manager";
import { composeToolComponent, renderExpansionAffordance } from "pi-cosmic-ui/tool";
import { INTERCOM_MESSAGE_TYPE } from "./delivery.ts";
import { SenderSchema } from "./transport/protocol.ts";

const MAX_LINE_CHARS = 200;

const Envelope = Schema.Struct({
  content: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.Unknown)])),
  details: Schema.optional(Schema.Struct({ from: SenderSchema })),
});
const TextPart = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });

const decodeEnvelope = Schema.decodeUnknownOption(Envelope, { onExcessProperty: "ignore" });
const isTextPart = Schema.is(TextPart);

const contentText = (content: string | ReadonlyArray<unknown> | undefined): string =>
  Predicate.isString(content)
    ? content
    : Arr.join(
        Arr.map(Arr.filter(content ?? [], isTextPart), (part) => part.text),
        "\n",
      );

/** A line of text already stripped of terminal controls, as one line of single spaces. */
const collapseWhitespace = (line: string): string =>
  Str.trim(Fn.pipe(line, Str.replace(/\s+/g, " ")));

/**
 * The first non-empty line of what the sender wrote, from text already stripped of terminal
 * controls: the frame's opening line names the sender and the message starts on the next one.
 * Lines after it are never read.
 */
const firstMessageLine = (text: string): string => {
  let end = indexOfFrom(text, "\n", 0);
  while (end !== -1) {
    const start = end + 1;
    end = indexOfFrom(text, "\n", start);
    const line = collapseWhitespace(Fn.pipe(text, Str.slice(start, end === -1 ? undefined : end)));
    if (Str.isNonEmpty(line)) return clipText(line, MAX_LINE_CHARS);
  }
  return "";
};

/**
 * Shows a message from another session: the sender and the message's first line collapsed, the
 * full framed text expanded. Undecodable details fall back to a generic sender. Pi renders every
 * frame, so the collapsed rows are kept for the width they were rendered at.
 */
export const renderIntercomMessage: MessageRenderer = (message, options, theme) => {
  const envelope = Option.getOrUndefined(decodeEnvelope(message));
  const text = stripTerminalControls(contentText(envelope?.content));
  if (options.expanded) return new Text(text, options.outputPad, 0);
  const from = envelope?.details?.from;
  const sender = from ? sessionSubject(from) : "another session";
  const subject = `${sender}: ${firstMessageLine(text)}`;
  const compact = captureCodePreviewPresentationPolicy().toolCallCollapsedStyle === "compact";
  const hint = compact ? undefined : renderExpansionAffordance("message", false, theme);
  let rendered: { readonly width: number; readonly rows: string[] } | undefined;
  return composeToolComponent((width) => {
    if (rendered?.width === width) return rendered.rows;
    const inner = Math.max(1, width - options.outputPad * 2);
    const row = renderCompactRow(
      {
        name: "intercom",
        phase: "settled",
        summary: { action: "Message from", subject },
        status: "returned",
      },
      theme,
      inner,
    );
    const rows = new Text(
      hint ? `${row}\n${clipToWidth(hint, inner)}` : row,
      options.outputPad,
      0,
    ).render(width);
    rendered = { width, rows };
    return rows;
  });
};

export const registerIntercomMessageRenderer = (pi: ExtensionAPI): void => {
  pi.registerMessageRenderer(INTERCOM_MESSAGE_TYPE, renderIntercomMessage);
};
