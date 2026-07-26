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

export interface SubagentNotificationDelivery {
  readonly deliveredCompletionKeys: ReadonlyArray<string>;
}

export interface SubagentNotifier {
  (notification: SubagentNotification): SubagentNotificationDelivery | undefined;
  reset(): void;
}

const MAX_NOTIFICATION_CHARS = 32 * 1024;
const MAX_DEDUPE_RUNS = 128;
const completionKey = (run: SubagentCompletionNotification): string =>
  `${run.id}:${run.generation}`;

const remember = <A>(map: Map<string, A>, key: string, value: A): void => {
  if (!map.has(key) && map.size >= MAX_DEDUPE_RUNS) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.delete(key);
  map.set(key, value);
};

const clip = (value: string, maximumLength = MAX_NOTIFICATION_CHARS): string =>
  sanitizeDiagnosticContent(value, { maximumLength }).trim();

interface CompletionChunk {
  readonly content: string;
  readonly runs: ReadonlyArray<SubagentCompletionNotification>;
}

const completionSection = (run: SubagentCompletionNotification): string =>
  `## ${run.name} (${run.id})${run.finalText ? `\n\n${run.finalText}` : "\n\nCompleted without a final report."}`;

const boundedCompletionSection = (
  run: SubagentCompletionNotification,
  maximumLength: number,
): string => {
  const section = completionSection(run);
  if (section.length <= maximumLength) return clip(section, maximumLength);
  const marker = `\n\n[Report truncated; use subagent status or await for ${run.id}.]`;
  return `${clip(section, Math.max(0, maximumLength - marker.length))}${marker}`;
};

const completionChunks = (
  runs: ReadonlyArray<SubagentCompletionNotification>,
): ReadonlyArray<CompletionChunk> => {
  if (runs.length === 1) {
    const run = runs[0]!;
    const prefix = `Background subagent ${run.name} (${run.id}) completed.`;
    const maximumReportLength = Math.max(0, MAX_NOTIFICATION_CHARS - prefix.length - 2);
    const report = run.finalText
      ? boundedCompletionSection({ ...run, name: "Final report" }, maximumReportLength).replace(
          `## Final report (${run.id})\n\n`,
          "",
        )
      : undefined;
    const content = report ? `${prefix}\n\n${report}` : prefix;
    return [{ content: clip(content), runs: [run] }];
  }

  const chunks: CompletionChunk[] = [];
  let chunkRuns: SubagentCompletionNotification[] = [];
  let sections: string[] = [];
  const flush = () => {
    if (chunkRuns.length === 0) return;
    const continuation = chunks.length === 0 ? "" : ` (continued ${chunks.length + 1})`;
    const header = `${runs.length} background subagents completed${continuation}.`;
    chunks.push({ content: clip(`${header}\n\n${sections.join("\n\n")}`), runs: chunkRuns });
    chunkRuns = [];
    sections = [];
  };

  for (const run of runs) {
    const baseHeader = `${runs.length} background subagents completed.`;
    const maximumSectionLength = Math.max(256, MAX_NOTIFICATION_CHARS - baseHeader.length - 2);
    const section = boundedCompletionSection(run, maximumSectionLength);
    const candidate = `${baseHeader}\n\n${[...sections, section].join("\n\n")}`;
    if (sections.length > 0 && candidate.length > MAX_NOTIFICATION_CHARS) flush();
    chunkRuns.push(run);
    sections.push(section);
  }
  flush();
  return chunks;
};

export function makeHostNotifier(pi: ExtensionAPI): SubagentNotifier {
  const deliveredCompletions = new Map<string, number>();
  const deliveredQuestions = new Map<string, string>();

  const notify: SubagentNotifier = (notification) => {
    // Routine progress is already projected into the footer and /subagents fleet.
    // Keeping it out of model context prevents stale queued progress turns.
    if (notification.type === "progress") return undefined;

    if (notification.type === "completed") {
      const fresh = notification.runs.filter(
        (run) => (deliveredCompletions.get(run.id) ?? 0) < run.generation,
      );
      if (fresh.length === 0) return { deliveredCompletionKeys: [] };
      const deliveredCompletionKeys: string[] = [];
      for (const chunk of completionChunks(fresh)) {
        try {
          pi.sendMessage(
            {
              customType: "pi-subagents-completed",
              content: chunk.content,
              display: true,
            },
            // Steering joins an active orchestration run before its next model call.
            // Unlike followUp, it cannot accumulate behind the final synthesis.
            { deliverAs: "steer", triggerTurn: true },
          );
          for (const run of chunk.runs) {
            const key = completionKey(run);
            remember(deliveredCompletions, run.id, run.generation);
            deliveredCompletionKeys.push(key);
          }
        } catch {
          // Session shutdown can race with a final child notification. Leave this
          // chunk and later chunks unacknowledged so the service can retry them.
          break;
        }
      }
      return { deliveredCompletionKeys };
    }

    const questionKey =
      notification.type === "question" ? `${notification.id}:${notification.requestId}` : undefined;
    if (
      questionKey &&
      notification.type === "question" &&
      deliveredQuestions.get(notification.id) === notification.requestId
    )
      return undefined;
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
      if (questionKey && notification.type === "question")
        remember(deliveredQuestions, notification.id, notification.requestId);
    } catch {
      // Session shutdown can race with a final child notification.
    }
    return undefined;
  };

  notify.reset = () => {
    deliveredCompletions.clear();
    deliveredQuestions.clear();
  };
  return notify;
}
