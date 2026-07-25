import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sanitizeDiagnosticError } from "pi-cosmic-core";

export type SubagentNotification =
  | {
      readonly type: "completed";
      readonly id: string;
      readonly name: string;
      readonly finalText?: string;
    }
  | {
      readonly type: "question";
      readonly id: string;
      readonly name: string;
      readonly requestId: string;
      readonly message: string;
    }
  | {
      readonly type: "warning";
      readonly id: string;
      readonly name: string;
      readonly message: string;
    };

export type SubagentNotifier = (notification: SubagentNotification) => void;

const clip = (value: string): string =>
  sanitizeDiagnosticError(value, { maximumLength: 32 * 1024 });

export function makeHostNotifier(pi: ExtensionAPI): SubagentNotifier {
  return (notification) => {
    const content = clip(
      notification.type === "completed"
        ? `Background subagent ${notification.name} (${notification.id}) completed.${notification.finalText ? `\n\n${notification.finalText}` : ""}`
        : notification.type === "question"
          ? `Subagent ${notification.name} (${notification.id}) is waiting for a parent reply.\n\nQuestion: ${notification.message}\n\nReply with subagent({ action: "reply", runId: "${notification.id}", message: "..." }).`
          : `Subagent ${notification.name} (${notification.id}) warning: ${notification.message}`,
    );
    try {
      pi.sendMessage(
        {
          customType: `pi-subagents-${notification.type}`,
          content,
          display: true,
          details: notification,
        },
        {
          deliverAs: notification.type === "question" ? "steer" : "followUp",
          triggerTurn: true,
        },
      );
    } catch {
      // Session shutdown can race with a final child notification.
    }
  };
}
