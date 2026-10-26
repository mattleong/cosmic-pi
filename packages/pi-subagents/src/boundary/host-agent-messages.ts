import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  agentMessageRecipientState,
  deliverAgentMessage,
  readLatestReply,
} from "pi-cosmic-core/host-agent-messages";
import { type SessionWake } from "pi-cosmic-core/host-wake";
import { MAX_MAIN_READ_CHARS, type AgentMainCapabilities } from "../run/agent-messaging.ts";

export const AGENT_MESSAGE_TYPE = "pi-subagents-agent-message";

interface AgentMessageHost {
  /** The shared root wake, which decides whether a message starts a turn. */
  readonly wake: SessionWake;
  /** The session that receives messages; undefined once it was replaced or retired. */
  readonly session: () => ExtensionContext | undefined;
}

/**
 * Reaches the root session's main agent for `agent_*` messages. A message starts a turn only when
 * the session is idle and not held; a busy session continues its settling run for it. Otherwise the
 * message is only appended. A session being replaced or shut down refuses it as unavailable.
 */
export function agentMainCapabilities(
  pi: ExtensionAPI,
  host: AgentMessageHost,
): AgentMainCapabilities {
  const current = () => host.session() !== undefined;
  return {
    deliver: (frame) => {
      if (!current() || host.wake.closing()) return "unavailable";
      const delivery = deliverAgentMessage(
        pi,
        host.wake,
        {
          customType: AGENT_MESSAGE_TYPE,
          content: frame.content,
          details: {
            from: frame.from,
            fromName: frame.fromName,
            to: frame.to,
            messageId: frame.messageId,
          },
        },
        current,
      );
      // Closing was refused above, in the same synchronous callback.
      return delivery === "refused" || delivery === "closing"
        ? "unavailable"
        : agentMessageRecipientState(delivery);
    },
    read: () => {
      const ctx = host.session();
      if (!ctx) throw new Error("The session that owned the main agent was replaced.");
      const latest = readLatestReply(ctx, MAX_MAIN_READ_CHARS);
      return { ...latest, text: latest.text ?? "" };
    },
  };
}
