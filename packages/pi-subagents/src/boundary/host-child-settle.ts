import * as Arr from "effect/Array";
import type * as Schema from "effect/Schema";
import * as Str from "effect/String";
import type {
  AgentBeforeSettleEventResult,
  BoundaryContextPreview,
  CustomMessageEntryDraft,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { hasUnansweredNotice } from "pi-cosmic-core/host-wake";
import { invokeHostCallback } from "pi-cosmic-core/host-session";

export const PROXY_NOTIFICATION_MESSAGE_TYPE = "pi-subagents-proxy-notification";
export const FINAL_REPORT_REMINDER_MESSAGE_TYPE = "pi-subagents-final-report-reminder";
export const PEER_NOTICE_MESSAGE_TYPE = "pi-subagents-peer-notice";

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
    Arr.every(last.content, (part) => part.type !== "text" || Str.trim(part.text) === "")
  );
};

/**
 * Owns how a nested Pi child takes descendant notices and finishes its turn. A notice is taken only
 * while the run the parent opened is working and hasn't reached this extension's settle check: Pi
 * appends it at turn end, outside the steering queue an interrupt clears, and the settling run
 * continues so the child reacts. Any other time the child refuses it, so it goes to the next
 * ancestor or the root instead of arriving after the parent took this run's report. A final message
 * without text gets one reminder per prompt before the parent records the run as failed.
 */
export function registerChildSettle(
  pi: ExtensionAPI,
  isIdle: () => boolean,
): (message: string, details?: Schema.Json) => boolean {
  let reminded = false;
  // The parent opens a run with its prompt, the child's only user input, and the run's settled
  // event closes it. A continuation after the settle check starts a turn and reopens it.
  let open = false;
  let settling = false;

  pi.on("before_agent_start", (event) => {
    if (event.messageType !== "user") return;
    reminded = false;
    open = true;
    settling = false;
  });

  pi.on("turn_start", () => {
    if (open) settling = false;
  });

  pi.on("agent_settled", () => {
    open = false;
  });

  pi.on("agent_before_settle", (event): AgentBeforeSettleEventResult | undefined => {
    // Pending notices are in this context, so any taken from here on would get no reaction.
    settling = true;
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

  return (message, details) =>
    open &&
    !settling &&
    !invokeHostCallback(isIdle, true) &&
    invokeHostCallback(() => {
      pi.sendMessage(
        {
          customType: PROXY_NOTIFICATION_MESSAGE_TYPE,
          content: message,
          display: true,
          ...(details !== undefined && { details }),
        },
        { triggerTurn: false },
      );
      return true;
    }, false);
}
