import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { invokeHostCallback, latestAssistantText, type SessionWake } from "pi-cosmic-core";
import {
  MAX_MAIN_READ_CHARS,
  type AgentMainCapabilities,
  type AgentMessageFrame,
} from "../run/agent-messaging.ts";

export const AGENT_MESSAGE_TYPE = "pi-subagents-agent-message";

interface AgentMessageHost {
  /** The shared root wake, which decides whether a message starts a turn. */
  readonly wake: SessionWake;
  /** The session that receives messages; undefined once it was replaced or retired. */
  readonly session: () => ExtensionContext | undefined;
}

const sessionIdle = (ctx: ExtensionContext): boolean =>
  invokeHostCallback(() => ctx.isIdle(), false);

/**
 * Reaches the root session's main agent for `agent_*` messages. A message starts a turn only when
 * the session is idle and not held and its wake budget admits one; a busy session continues its
 * settling run for it under the same budget. Otherwise the message is only appended.
 */
export function agentMainCapabilities(
  pi: ExtensionAPI,
  host: AgentMessageHost,
): AgentMainCapabilities {
  const send = (frame: AgentMessageFrame) => (startTurn: boolean) =>
    invokeHostCallback(() => {
      pi.sendMessage(
        {
          customType: AGENT_MESSAGE_TYPE,
          content: frame.content,
          display: true,
          details: {
            from: frame.from,
            fromName: frame.fromName,
            to: frame.to,
            messageId: frame.messageId,
          },
        },
        { deliverAs: "steer", triggerTurn: startTurn },
      );
      return true;
    }, false);
  return {
    deliver: (frame, budget) => {
      if (!host.session()) return "unavailable";
      const delivery = host.wake.deliver(send(frame), budget);
      return delivery === "refused" ? "unavailable" : delivery;
    },
    read: () => {
      const ctx = host.session();
      if (!ctx) throw new Error("The session that owned the main agent was replaced.");
      const latest = latestAssistantText(ctx.sessionManager.getBranch(), MAX_MAIN_READ_CHARS);
      return {
        text: latest?.text ?? "",
        truncated: latest?.truncated ?? false,
        state: sessionIdle(ctx) ? "idle" : "busy",
      };
    },
  };
}

/** Each prompt the user sends starts new budgets of agent messages and of their wakes and resumes. */
export function registerAgentMessageBudgetReset(pi: ExtensionAPI, reset: () => void): void {
  pi.on("input", (event) => {
    if (event.source !== "extension") reset();
  });
}
