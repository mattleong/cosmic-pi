import { Text } from "@earendil-works/pi-tui";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { CodePreviewMessagePresenter } from "pi-code-previews";
import { clipText } from "pi-cosmic-core/display";
import { sanitizeTerminalLine, stripTerminalControls } from "pi-cosmic-core/security";
import { composeToolComponent } from "pi-cosmic-ui/tool";
import { agentTextLines, bodyIndent, detailsSectionLines } from "./agent-text.ts";
import { decodeMessageEnvelope, messageContentText } from "./message-envelope.ts";
import { MAX_NOTICE_TEXT_CHARS } from "./notice-details.ts";

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024));
const AgentMessageDetailsSchema = Schema.Struct({
  from: Id,
  fromName: Schema.optionalKey(Id),
  to: Id,
  messageId: Id,
  /** A bounded display copy of the sender's words, without the frame the recipient reads. */
  text: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_NOTICE_TEXT_CHARS)),
  ),
  textCut: Schema.optionalKey(Schema.Literal(true)),
});
export type AgentMessageDetails = typeof AgentMessageDetailsSchema.Type;
const decodeDetails = Schema.decodeUnknownOption(AgentMessageDetailsSchema, {
  onExcessProperty: "ignore",
});

const displayName = (name: string): string => clipText(sanitizeTerminalLine(name), 60);

/**
 * An agent message to the main agent: who sent it, then its words. Details without a display copy
 * show the sender collapsed and the message as the main agent received it expanded.
 */
export const presentAgentMessage: CodePreviewMessagePresenter = (input, options, theme) => {
  const envelope = Option.getOrUndefined(decodeMessageEnvelope(input));
  const details = Option.getOrUndefined(decodeDetails(envelope?.details));
  const words = details?.text;
  const sender = details ? displayName(details.fromName ?? details.from) : "";
  // The arrow icon already says the message came in; a recipient shows only when it isn't main.
  const recipient = details && details.to !== "main" ? ` → ${displayName(details.to)}` : "";
  const summary = {
    subject: sender ? `${sender}${recipient}` : "another agent",
    outcome: "returned",
    messageIcon: "received",
  } as const;
  const presentation = { name: "agent_message", label: "Agent message", summary };
  if (words === undefined)
    return {
      ...presentation,
      expandLabel: "message",
      expanded: () => new Text(stripTerminalControls(messageContentText(envelope?.content)), 0, 0),
    };
  const facts = (width: number) =>
    details
      ? detailsSectionLines(
          [
            `From ${sanitizeTerminalLine(details.from)} · message ${sanitizeTerminalLine(details.messageId)}`,
            ...(details.textCut
              ? ["Shown up to its display limit; the agent received all of it"]
              : []),
          ],
          width,
          theme,
        )
      : [];
  return {
    ...presentation,
    collapsed: () =>
      composeToolComponent((width) =>
        agentTextLines(words, width, theme, { expanded: false, indent: bodyIndent(options) }),
      ),
    expanded: () =>
      composeToolComponent((width) => [
        ...agentTextLines(words, width, theme, { expanded: true }),
        ...facts(width),
      ]),
  };
};
