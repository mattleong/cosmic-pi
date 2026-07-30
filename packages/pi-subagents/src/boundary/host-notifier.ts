import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sanitizeDiagnosticContent } from "pi-cosmic-core";
import { safeTextPrefix } from "../run/state.ts";

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
      readonly generation: number;
    }
  | {
      readonly type: "warning";
      readonly id: string;
      readonly name: string;
      readonly message: string;
      readonly triggerTurn: boolean;
      readonly generation: number;
      /** Service-owned identity for independently retried warning classes. */
      readonly slotKey?: string | undefined;
    };

export interface SubagentNotificationDelivery {
  readonly deliveredCompletionKeys?: ReadonlyArray<string> | undefined;
  readonly deliveredActionKeys?: ReadonlyArray<string> | undefined;
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

const clip = (value: string, maximumLength = MAX_NOTIFICATION_CHARS): string => {
  const sanitized = sanitizeDiagnosticContent(value, { maximumLength: maximumLength + 2 }).trim();
  if (sanitized.length <= maximumLength) return sanitized;
  return `${safeTextPrefix(sanitized, Math.max(0, maximumLength - 1)).trimEnd()}…`;
};

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
  const marker = `\n\n[Report truncated; use subagent_status or subagent_await for ${run.id}.]`;
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
      : "Completed without a final report.";
    const content = `${prefix}\n\n${report}`;
    return [{ content: clip(content), runs: [run] }];
  }

  const chunks: CompletionChunk[] = [];
  let chunkRuns: SubagentCompletionNotification[] = [];
  let sections: string[] = [];
  const headerFor = (chunkIndex: number): string => {
    const continuation = chunkIndex === 0 ? "" : ` (continued ${chunkIndex + 1})`;
    return `${runs.length} background subagents completed${continuation}.`;
  };
  const flush = () => {
    if (chunkRuns.length === 0) return;
    const header = headerFor(chunks.length);
    chunks.push({ content: `${header}\n\n${sections.join("\n\n")}`, runs: chunkRuns });
    chunkRuns = [];
    sections = [];
  };

  for (const run of runs) {
    let header = headerFor(chunks.length);
    const unboundedSection = completionSection(run);
    const occupied = header.length + 2 + sections.join("\n\n").length;
    const separator = sections.length > 0 ? 2 : 0;
    if (
      sections.length > 0 &&
      occupied + separator + unboundedSection.length > MAX_NOTIFICATION_CHARS
    ) {
      flush();
      header = headerFor(chunks.length);
    }
    const currentSectionsLength = sections.join("\n\n").length;
    const maximumSectionLength = Math.max(
      0,
      MAX_NOTIFICATION_CHARS -
        header.length -
        2 -
        currentSectionsLength -
        (sections.length ? 2 : 0),
    );
    chunkRuns.push(run);
    sections.push(boundedCompletionSection(run, maximumSectionLength));
  }
  flush();
  return chunks;
};

export function makeHostNotifier(pi: ExtensionAPI): SubagentNotifier {
  const deliveredCompletions = new Map<string, number>();
  const deliveredActions = new Map<string, number>();

  const notify: SubagentNotifier = (notification) => {
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

    const actionIdentity = `${notification.id}:${notification.type}:${notification.type === "warning" ? (notification.slotKey ?? "default") : "default"}`;
    const actionKey = `${actionIdentity}:${notification.generation}`;
    if ((deliveredActions.get(actionIdentity) ?? 0) >= notification.generation)
      return { deliveredActionKeys: [actionKey] };
    const content = clip(
      notification.type === "question"
        ? `Subagent ${notification.name} (${notification.id}) is waiting for a parent reply.\n\nQuestion: ${notification.message}\n\nReply with subagent_reply({ runId: "${notification.id}", message: "..." }).`
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
      remember(deliveredActions, actionIdentity, notification.generation);
      return { deliveredActionKeys: [actionKey] };
    } catch {
      // Session shutdown can race with an actionable notification. The service retains it.
      return { deliveredActionKeys: [] };
    }
  };

  notify.reset = () => {
    deliveredCompletions.clear();
    deliveredActions.clear();
  };
  return notify;
}
