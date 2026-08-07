import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sanitizeDiagnosticContent } from "pi-cosmic-core";
import { safeTextPrefix } from "../run/state.ts";

export interface SubagentCompletionNotification {
  readonly id: string;
  readonly name: string;
  readonly generation: number;
  /** Omitted by legacy embedders; absence means a successful completed outcome. */
  readonly outcome?: "completed" | "failed" | undefined;
  readonly finalText?: string | undefined;
  readonly error?: string | undefined;
  readonly warning?: string | undefined;
  readonly retained?: boolean | undefined;
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
const MAX_DEDUPE_KEYS = 1_024;
const completionKey = (run: SubagentCompletionNotification): string =>
  `${run.id}:${run.generation}`;

const remember = <A>(map: Map<string, A>, key: string, value: A): void => {
  if (!map.has(key) && map.size >= MAX_DEDUPE_KEYS) {
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

const completionWarning = (run: SubagentCompletionNotification): string | undefined => {
  const warning = run.warning?.trim();
  return warning && warning !== run.error?.trim() ? `Warning: ${warning}` : undefined;
};

const completionBody = (run: SubagentCompletionNotification): string => {
  const warning = completionWarning(run);
  const primary =
    run.outcome === "failed"
      ? `Error: ${run.error?.trim() || "Run failed without an error report."}`
      : run.finalText?.trim() || "Completed without a final report.";
  return warning ? `${primary}\n\n${warning}` : primary;
};

const completionHeading = (run: SubagentCompletionNotification): string =>
  run.outcome === "failed"
    ? `failed outcome ${run.generation}`
    : `report ${run.generation}${run.retained ? " · retained" : ""}`;

const completionSection = (run: SubagentCompletionNotification): string =>
  `## ${run.name} (${run.id}) · ${completionHeading(run)}\n\n${completionBody(run)}`;

const boundedCompletionSection = (
  run: SubagentCompletionNotification,
  maximumLength: number,
): string => {
  const section = completionSection(run);
  if (section.length <= maximumLength) return clip(section, maximumLength);
  const noun = run.outcome === "failed" ? "Outcome" : "Report";
  const marker = `\n\n[${noun} truncated; use subagent_status or subagent_await for ${run.id}.]`;
  return `${clip(section, Math.max(0, maximumLength - marker.length))}${marker}`;
};

const boundedCompletionBody = (
  run: SubagentCompletionNotification,
  maximumLength: number,
): string => {
  const body = completionBody(run);
  if (body.length <= maximumLength) return clip(body, maximumLength);
  const noun = run.outcome === "failed" ? "Outcome" : "Report";
  const marker = `\n\n[${noun} truncated; use subagent_status or subagent_await for ${run.id}.]`;
  return `${clip(body, Math.max(0, maximumLength - marker.length))}${marker}`;
};

const completionChunks = (
  runs: ReadonlyArray<SubagentCompletionNotification>,
): ReadonlyArray<CompletionChunk> => {
  if (runs.length === 1) {
    const run = runs[0]!;
    const prefix =
      run.outcome === "failed"
        ? `Background subagent ${run.name} (${run.id}) failed.`
        : run.retained
          ? `Background subagent ${run.name} (${run.id}) reported generation ${run.generation} and remains available for guidance.`
          : `Background subagent ${run.name} (${run.id}) completed.`;
    const maximumBodyLength = Math.max(0, MAX_NOTIFICATION_CHARS - prefix.length - 2);
    const content = `${prefix}\n\n${boundedCompletionBody(run, maximumBodyLength)}`;
    return [{ content: clip(content), runs: [run] }];
  }

  const chunks: CompletionChunk[] = [];
  let chunkRuns: SubagentCompletionNotification[] = [];
  let sections: string[] = [];
  const failed = runs.filter((run) => run.outcome === "failed").length;
  const retained = runs.filter((run) => run.outcome !== "failed" && run.retained).length;
  const closed = runs.length - retained - failed;
  const headerFor = (chunkIndex: number): string => {
    const continuation = chunkIndex === 0 ? "" : ` (continued ${chunkIndex + 1})`;
    const outcomes = [
      closed > 0 ? `${closed} completed` : undefined,
      failed > 0 ? `${failed} failed` : undefined,
      retained > 0 ? `${retained} reported and retained` : undefined,
    ]
      .filter((value): value is string => value !== undefined)
      .join(" · ");
    return `${runs.length} background subagents finished${continuation} · ${outcomes}.`;
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
  const deliveredCompletions = new Map<string, true>();
  const deliveredActions = new Map<string, number>();

  const notify: SubagentNotifier = (notification) => {
    if (notification.type === "completed") {
      const fresh = notification.runs.filter(
        (run) => !deliveredCompletions.has(completionKey(run)),
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
            // Terminal outcomes intentionally join an active orchestration run or wake an idle
            // parent. Host acceptance is synchronous; model consumption may occur later.
            { deliverAs: "steer", triggerTurn: true },
          );
          for (const run of chunk.runs) {
            const key = completionKey(run);
            remember(deliveredCompletions, key, true);
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

    const actionIdentity = `${notification.id}:question:default`;
    const actionKey = `${actionIdentity}:${notification.generation}`;
    if ((deliveredActions.get(actionIdentity) ?? 0) >= notification.generation)
      return { deliveredActionKeys: [actionKey] };
    const content = clip(
      `Subagent ${notification.name} (${notification.id}) is waiting for a parent reply.\n\nQuestion: ${notification.message}\n\nReply with subagent_reply({ runId: "${notification.id}", message: "..." }), then call subagent_await again.`,
    );
    try {
      pi.sendMessage(
        {
          customType: "pi-subagents-question",
          content,
          display: true,
        },
        { deliverAs: "steer", triggerTurn: true },
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
