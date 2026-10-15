import type {
  AgentBeforeSettleEventResult,
  BoundaryContextPreview,
  CustomMessageEntryDraft,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { invokeHostCallback } from "pi-cosmic-core";
import { hasUnansweredNotice } from "./notice-wake.ts";

export const PROXY_NOTIFICATION_MESSAGE_TYPE = "pi-subagents-proxy-notification";
export const FINAL_REPORT_REMINDER_MESSAGE_TYPE = "pi-subagents-final-report-reminder";

const PROXY_NOTICE_TYPES: ReadonlySet<string> = new Set([PROXY_NOTIFICATION_MESSAGE_TYPE]);

const FINAL_REPORT_REMINDER: CustomMessageEntryDraft = {
  type: "custom_message",
  customType: FINAL_REPORT_REMINDER_MESSAGE_TYPE,
  content:
    "Your last message had no text, so your parent received no report. Reply now with your final report: what you did, what you found, and anything left open.",
  display: false,
};

const endsWithEmptyReport = (context: BoundaryContextPreview): boolean => {
  const last = context.contextMessages.at(-1);
  return (
    last?.role === "assistant" &&
    last.stopReason === "stop" &&
    last.content.every((part) => part.type !== "text" || part.text.trim() === "")
  );
};

/**
 * Owns how a nested Pi child takes descendant notices and finishes its turn. A notice starts a turn
 * only while the child is idle; while it works, Pi appends the notice at turn end, outside the
 * steering queue an interrupt clears, and the settling run continues so the child reacts. A final
 * message without text gets one reminder per prompt before the parent records the run as failed.
 */
export function registerChildSettle(
  pi: ExtensionAPI,
  isIdle: () => boolean,
): (message: string) => boolean {
  let reminded = false;

  pi.on("before_agent_start", (event) => {
    if (event.messageType === "user") reminded = false;
  });

  pi.on("agent_before_settle", (event): AgentBeforeSettleEventResult | undefined => {
    if (event.outcome !== "completed") return undefined;
    const landed = hasUnansweredNotice(event.context, PROXY_NOTICE_TYPES);
    const remind = !reminded && endsWithEmptyReport(event.context);
    if (remind) reminded = true;
    if (!landed && !remind) return undefined;
    return {
      entries: remind ? [...event.entries, FINAL_REPORT_REMINDER] : event.entries,
      continue: true,
    };
  });

  return (message) =>
    invokeHostCallback(() => {
      pi.sendMessage(
        { customType: PROXY_NOTIFICATION_MESSAGE_TYPE, content: message, display: true },
        { deliverAs: "steer", triggerTurn: invokeHostCallback(isIdle, false) },
      );
      return true;
    }, false);
}
