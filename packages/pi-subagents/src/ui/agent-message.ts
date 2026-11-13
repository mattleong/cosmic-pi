import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { CodePreviewMessagePresenter } from "pi-code-previews";
import { composeToolComponent } from "pi-cosmic-ui/tool";
import { agentTextLines, bodyIndent, expandedRowsBody } from "./agent-text.ts";
import { agentFactLines } from "./run-facts.ts";
import { decodeMessageEnvelope, receivedMessageBody } from "./message-envelope.ts";
import { AgentIdSchema, displayName, MAX_NOTICE_TEXT_CHARS } from "./notice-details.ts";

const AgentMessageDetailsSchema = Schema.Struct({
  from: AgentIdSchema,
  fromName: Schema.optionalKey(AgentIdSchema),
  to: AgentIdSchema,
  messageId: AgentIdSchema,
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

/**
 * An agent message to the main agent: who sent it, then its words. Details without a display copy
 * show the sender collapsed and the message as the main agent received it expanded.
 */
export const presentAgentMessage: CodePreviewMessagePresenter = (input, options, theme) => {
  const envelope = Option.getOrUndefined(decodeMessageEnvelope(input));
  const details = Option.getOrUndefined(decodeDetails(envelope?.details));
  const sender = details ? displayName(details.fromName ?? details.from) : "";
  // The arrow icon already says the message came in; a recipient shows only when it isn't main.
  const recipient = details && details.to !== "main" ? ` → ${displayName(details.to)}` : "";
  const summary = {
    subject: sender ? `${sender}${recipient}` : "another agent",
    outcome: "returned",
    messageIcon: "received",
  } as const;
  const presentation = { name: "agent_message", label: "Agent message", summary };
  if (details?.text === undefined)
    return {
      ...presentation,
      expandLabel: "message",
      expanded: () => receivedMessageBody(theme, envelope?.content),
    };
  const words = details.text;
  const facts = [
    ...agentFactLines(sender, [details.from, `message ${details.messageId}`]),
    ...(details.textCut ? ["Shown up to its display limit; the agent received all of it"] : []),
  ];
  return {
    ...presentation,
    // A collapsed compact row hides the words. In preview style they show collapsed, clipped with
    // their own affordance, and expansion adds the sender's IDs.
    expandLabel: options.collapsedStyle === "compact" ? "message" : "details",
    collapsed: () =>
      composeToolComponent((width) =>
        agentTextLines(words, width, theme, { expanded: false, indent: bodyIndent(options) }),
      ),
    expanded: () =>
      expandedRowsBody(
        theme,
        (width) => agentTextLines(words, width, theme, { expanded: true, indent: 0 }),
        facts,
      ),
  };
};
