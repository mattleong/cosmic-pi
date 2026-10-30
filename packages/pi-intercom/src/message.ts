import type { ExtensionAPI, MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { withCodePreviewMessageShell, type CodePreviewMessagePresenter } from "pi-code-previews";
import { stripTerminalControls } from "pi-cosmic-core/security";
import { composeToolComponent } from "pi-cosmic-ui/tool";
import { INTERCOM_MESSAGE_TYPE } from "./delivery.ts";
import { detailsLine, textBody } from "./display.ts";
import { sessionSubject } from "./tools/summary.ts";
import { MAX_MESSAGE_CHARS, SenderSchema } from "./transport/protocol.ts";

const Envelope = Schema.Struct({
  content: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.Unknown)])),
  details: Schema.optional(Schema.Unknown),
});
const TextPart = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });

const decodeOptions = { onExcessProperty: "ignore" } as const;
const decodeEnvelope = Schema.decodeUnknownOption(Envelope, decodeOptions);
// Each field decodes alone, so a sender that doesn't decode still leaves the text to show.
const decodeSender = Schema.decodeUnknownOption(
  Schema.Struct({ from: SenderSchema }),
  decodeOptions,
);
const decodeText = Schema.decodeUnknownOption(
  Schema.Struct({ text: Schema.String.check(Schema.isMaxLength(MAX_MESSAGE_CHARS)) }),
  decodeOptions,
);
const isTextPart = Schema.is(TextPart);

const contentText = (content: string | ReadonlyArray<unknown> | undefined): string =>
  Predicate.isString(content)
    ? content
    : Arr.join(
        Arr.map(Arr.filter(content ?? [], isTextPart), (part) => part.text),
        "\n",
      );

const stack = (parts: ReadonlyArray<Component>): Component =>
  composeToolComponent((width) => Arr.flatMap(parts, (part) => part.render(width)));

/**
 * Shows a message from another session as what its sender wrote: who sent it, then the message
 * with its line breaks, bounded collapsed and complete expanded with the sender's session id and
 * directory. The frame the model reads, with its reply instructions, is never shown. A stored
 * message without display text shows its sender, and its stored content only expanded; one without
 * a sender names another session.
 */
export const presentIntercomMessage: CodePreviewMessagePresenter = (message, _options, theme) => {
  const envelope = Option.getOrUndefined(decodeEnvelope(message));
  const from = Option.getOrUndefined(decodeSender(envelope?.details))?.from;
  const text = Option.getOrUndefined(decodeText(envelope?.details))?.text;
  const sender = from ? sessionSubject(from) : "another session";
  const details = () => (from ? [detailsLine([`Session ${from.sessionId}`, from.cwd], theme)] : []);
  const presentation = {
    name: "session_message",
    label: "Session message",
    summary: { subject: sender, outcome: "returned", messageIcon: "received" },
  } as const;
  if (text === undefined)
    return {
      ...presentation,
      expandLabel: "message",
      expanded: () =>
        stack([
          new Text(stripTerminalControls(contentText(envelope?.content)), 0, 0),
          ...details(),
        ]),
    };
  return {
    ...presentation,
    collapsed: () => textBody(text, theme, false, "text"),
    expanded: () => stack([textBody(text, theme, true, "text"), ...details()]),
  };
};

export const renderIntercomMessage: MessageRenderer =
  withCodePreviewMessageShell(presentIntercomMessage);

export const registerIntercomMessageRenderer = (pi: ExtensionAPI): void => {
  pi.registerMessageRenderer(INTERCOM_MESSAGE_TYPE, renderIntercomMessage);
};
