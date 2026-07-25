import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sanitizeDiagnosticContent } from "pi-cosmic-core";

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
      readonly type: "progress" | "warning";
      readonly id: string;
      readonly name: string;
      readonly message: string;
      readonly triggerTurn: boolean;
    };

export type SubagentNotifier = (notification: SubagentNotification) => void;

const clip = (value: string): string =>
  sanitizeDiagnosticContent(value, { maximumLength: 32 * 1024 }).trim();

export function makeHostNotifier(pi: ExtensionAPI): SubagentNotifier {
  return (notification) => {
    const content = clip(
      notification.type === "completed"
        ? `Background subagent ${notification.name} (${notification.id}) completed.${notification.finalText ? `\n\n${notification.finalText}` : ""}`
        : notification.type === "question"
          ? `Subagent ${notification.name} (${notification.id}) is waiting for a parent reply.\n\nQuestion: ${notification.message}\n\nReply with subagent({ action: "reply", runId: "${notification.id}", message: "..." }).`
          : `Subagent ${notification.name} (${notification.id}) ${notification.type}: ${notification.message}`,
    );
    const triggerTurn =
      notification.type === "completed" ||
      notification.type === "question" ||
      notification.triggerTurn;
    try {
      pi.sendMessage(
        {
          customType: `pi-subagents-${notification.type}`,
          content,
          display: true,
        },
        {
          deliverAs:
            notification.type === "question" ? "steer" : triggerTurn ? "followUp" : "nextTurn",
          triggerTurn,
        },
      );
    } catch {
      // Session shutdown can race with a final child notification.
    }
  };
}
