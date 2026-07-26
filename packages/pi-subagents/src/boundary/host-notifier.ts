import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sanitizeDiagnosticContent } from "pi-cosmic-core";

export interface SubagentCompletionNotification {
  readonly id: string;
  readonly name: string;
  readonly generation: number;
  readonly finalText?: string | undefined;
}

export type SubagentNotification =
  | {
      readonly type: "completed";
      readonly runs: ReadonlyArray<SubagentCompletionNotification>;
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

const completionContent = (runs: ReadonlyArray<SubagentCompletionNotification>): string => {
  if (runs.length === 1) {
    const run = runs[0]!;
    return `Background subagent ${run.name} (${run.id}) completed.${run.finalText ? `\n\n${run.finalText}` : ""}`;
  }
  const reports = runs
    .map(
      (run) =>
        `## ${run.name} (${run.id})${run.finalText ? `\n\n${run.finalText}` : "\n\nCompleted without a final report."}`,
    )
    .join("\n\n");
  return `${runs.length} background subagents completed.\n\n${reports}`;
};

export function makeHostNotifier(pi: ExtensionAPI): SubagentNotifier {
  const deliveredCompletions = new Set<string>();
  const deliveredQuestions = new Set<string>();

  return (notification) => {
    // Routine progress is already projected into the footer and /subagents fleet.
    // Keeping it out of model context prevents stale queued progress turns.
    if (notification.type === "progress") return;

    if (notification.type === "completed") {
      const fresh = notification.runs.filter((run) => {
        const key = `${run.id}:${run.generation}`;
        if (deliveredCompletions.has(key)) return false;
        deliveredCompletions.add(key);
        return true;
      });
      if (fresh.length === 0) return;
      try {
        pi.sendMessage(
          {
            customType: "pi-subagents-completed",
            content: clip(completionContent(fresh)),
            display: true,
          },
          // Steering joins an active orchestration run before its next model call.
          // Unlike followUp, it cannot accumulate behind the final synthesis.
          { deliverAs: "steer", triggerTurn: true },
        );
      } catch {
        // Session shutdown can race with a final child notification.
      }
      return;
    }

    if (notification.type === "question") {
      const key = `${notification.id}:${notification.requestId}`;
      if (deliveredQuestions.has(key)) return;
      deliveredQuestions.add(key);
    }
    const content = clip(
      notification.type === "question"
        ? `Subagent ${notification.name} (${notification.id}) is waiting for a parent reply.\n\nQuestion: ${notification.message}\n\nReply with subagent({ action: "reply", runId: "${notification.id}", message: "..." }).`
        : `Subagent ${notification.name} (${notification.id}) warning: ${notification.message}`,
    );
    try {
      pi.sendMessage(
        {
          customType: `pi-subagents-${notification.type}`,
          content,
          display: true,
        },
        {
          deliverAs: "steer",
          triggerTurn: notification.type === "question" || notification.triggerTurn,
        },
      );
    } catch {
      // Session shutdown can race with a final child notification.
    }
  };
}
