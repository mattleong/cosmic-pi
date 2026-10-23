import type { ExtensionAPI, MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { captureCodePreviewPresentationPolicy, renderCompactRow } from "pi-code-previews";
import { clipText, sanitizeTerminalLine, stripTerminalControls } from "pi-cosmic-core";
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

/**
 * The first line of what the sender wrote: the frame's opening line names the sender and the
 * message starts on the next one.
 */
const firstMessageLine = (text: string): string =>
  clipText(
    Option.getOrElse(
      Arr.findFirst(Arr.map(Str.split(text, "\n").slice(1), sanitizeTerminalLine), Str.isNonEmpty),
      () => "",
    ),
    MAX_LINE_CHARS,
  );

/**
 * Shows a message from another session: the sender and the message's first line collapsed, the
 * full framed text expanded. Undecodable details fall back to a generic sender.
 */
export const renderIntercomMessage: MessageRenderer = (message, options, theme) => {
  const envelope = Option.getOrUndefined(decodeEnvelope(message));
  const text = stripTerminalControls(contentText(envelope?.content));
  if (options.expanded) return new Text(text, options.outputPad, 0);
  const from = envelope?.details?.from;
  const sender = from ? sessionSubject(from) : "another session";
  const compact = captureCodePreviewPresentationPolicy().toolCallCollapsedStyle === "compact";
  const hint = compact ? undefined : renderExpansionAffordance("message", false, theme);
  return composeToolComponent((width) => {
    const inner = Math.max(1, width - options.outputPad * 2);
    const row = renderCompactRow(
      {
        name: "intercom",
        phase: "settled",
        summary: { action: "Message from", subject: `${sender}: ${firstMessageLine(text)}` },
        status: "returned",
      },
      theme,
      inner,
    );
    return new Text(
      hint ? `${row}\n${clipToWidth(hint, inner)}` : row,
      options.outputPad,
      0,
    ).render(width);
  });
};

export const registerIntercomMessageRenderer = (pi: ExtensionAPI): void => {
  pi.registerMessageRenderer(INTERCOM_MESSAGE_TYPE, renderIntercomMessage);
};
