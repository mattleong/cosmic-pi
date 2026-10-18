import type { MessageRenderer, Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { renderCompactRow } from "pi-code-previews";
import {
  clipText,
  firstLineMessage,
  sanitizeTerminalLine,
  stripTerminalControls,
} from "pi-cosmic-core";
import { clipToWidth } from "pi-cosmic-ui/manager";
import { composeToolComponent, renderExpansionAffordance } from "pi-cosmic-ui/tool";

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024));
const Details = Schema.Struct({
  from: Id,
  fromName: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024))),
  to: Id,
  messageId: Id,
});
const Envelope = Schema.Struct({
  content: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.Unknown)])),
  details: Schema.optional(Schema.Unknown),
});
const TextPart = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });

const decodeEnvelope = Schema.decodeUnknownOption(Envelope, { onExcessProperty: "ignore" });
const decodeDetails = Schema.decodeUnknownOption(Details, { onExcessProperty: "ignore" });
const isTextPart = Schema.is(TextPart);

const contentText = (content: string | ReadonlyArray<unknown> | undefined): string =>
  Predicate.isString(content)
    ? content
    : (content ?? [])
        .filter(isTextPart)
        .map((part) => part.text)
        .join("\n");

// The root frames each message as a sender line, the text, then a reply hint.
const FRAME_HEADER = /^Message from .*:$/u;

const messageLine = (text: string): string => {
  const lines = text.split("\n");
  const body = FRAME_HEADER.test(lines[0] ?? "") ? lines.slice(1, -1).join("\n") : text;
  return firstLineMessage(body, "");
};

/** An agent message to the main agent: sender and first line collapsed, the full frame expanded. */
export function renderAgentMessage(
  input: Parameters<MessageRenderer>[0],
  options: { expanded: boolean; outputPad: number },
  compact: boolean,
  theme: Theme,
): Component {
  const envelope = Option.getOrUndefined(decodeEnvelope(input));
  const text = contentText(envelope?.content);
  if (options.expanded) return new Text(stripTerminalControls(text), options.outputPad, 0);
  const details = Option.getOrUndefined(decodeDetails(envelope?.details));
  const sender = details
    ? clipText(sanitizeTerminalLine(details.fromName ?? details.from), 60)
    : "";
  const line = messageLine(text);
  const hint = compact ? undefined : renderExpansionAffordance("message", false, theme);
  return composeToolComponent((width) => {
    const inner = Math.max(1, width - options.outputPad * 2);
    const row = renderCompactRow(
      {
        name: "agent message",
        phase: "settled",
        summary: {
          ...(sender && { action: `from ${sender}` }),
          subject: line || "Message from another agent",
        },
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
}
