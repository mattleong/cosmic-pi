import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { invokeHostCallback } from "./host-session.ts";
import { latestAssistantText } from "./host-transcript.ts";
import type { SessionWake, SessionWakeDelivery } from "./host-wake.ts";

/** A message from another agent, as its recipient's model reads it. */
export interface AgentMessageFraming {
  /** The sender as the delivering side names it, never as the message text claims. */
  readonly sender: string;
  readonly text: string;
  /** The tool and address that reach the sender. */
  readonly replyTool: string;
  readonly replyTo: string;
  /** Why the message carries no user authority. */
  readonly authority: string;
}

/** The sender's line, the text, then when and how to reply and whose authority it lacks. */
export const frameAgentMessage = (framing: AgentMessageFraming): string =>
  [
    `Message from ${framing.sender}:`,
    framing.text,
    `Reply with ${framing.replyTool} to ${JSON.stringify(framing.replyTo)} only if the work needs it; don't reply just to acknowledge or thank. ${framing.authority}`,
  ].join("\n");

/** A displayed custom message carrying an agent message for the session's model. */
export interface AgentMessageNotice<Details> {
  readonly customType: string;
  readonly content: string;
  readonly details: Details;
}

/**
 * Hands `notice` to the session through its wake, which decides whether it starts a turn.
 * `isCurrent` is checked again in the callback that sends it, so a retired runtime never delivers
 * into its successor.
 */
export const deliverAgentMessage = <Details>(
  pi: ExtensionAPI,
  wake: SessionWake,
  notice: AgentMessageNotice<Details>,
  isCurrent: () => boolean,
): SessionWakeDelivery =>
  wake.deliver((startTurn) =>
    invokeHostCallback(() => {
      if (!isCurrent()) return false;
      // A session that started streaming since the wake found it idle reads it as steering.
      pi.sendMessage({ ...notice, display: true }, { deliverAs: "steer", triggerTurn: startTurn });
      return true;
    }, false),
  );

/**
 * The recipient's state when a message reached it: an idle session started a turn, a busy one
 * reads it before its turn ends, and a held one waits for its user, behind an open dialog or after
 * an interrupt.
 */
export type AgentMessageRecipientState = "idle" | "busy" | "held";

const RECIPIENT_STATES = {
  woken: "idle",
  queued: "busy",
  held: "held",
} as const satisfies Record<Exclude<SessionWakeDelivery, "refused">, AgentMessageRecipientState>;

export const agentMessageRecipientState = (
  delivery: Exclude<SessionWakeDelivery, "refused">,
): AgentMessageRecipientState => RECIPIENT_STATES[delivery];

const DELIVERY_TEXT: Record<AgentMessageRecipientState, (recipient: string) => string> = {
  idle: (recipient) => `${recipient} was idle; your message started its turn.`,
  busy: (recipient) => `${recipient} is busy; it sees your message before its current turn ends.`,
  held: (recipient) =>
    `${recipient} is waiting on its user, behind an open dialog or after an interrupt; your message waits in its conversation and wakes it when the dialog closes or on the user's next prompt.`,
};

/** How a delivered message reached `recipient`, for the sender's model. */
export const agentMessageDeliveryText = (
  state: AgentMessageRecipientState,
  recipient: string,
): string => DELIVERY_TEXT[state](recipient);

export interface SessionLatestReply {
  /** Absent when the branch has no assistant message. */
  readonly text?: string;
  readonly truncated: boolean;
  readonly state: "idle" | "busy";
}

/** The latest assistant reply on the session's branch, within `limit` UTF-8 bytes, and its state. */
export const readLatestReply = (ctx: ExtensionContext, limit: number): SessionLatestReply => {
  const latest = latestAssistantText(ctx.sessionManager.getBranch(), limit);
  return {
    ...(latest !== undefined && { text: latest.text }),
    truncated: latest?.truncated ?? false,
    state: ctx.isIdle() ? "idle" : "busy",
  };
};
