import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sanitizeDiagnosticContent } from "pi-cosmic-core";
import { safeTextPrefix } from "../run/state.ts";

export interface SubagentCompletionNotification {
  readonly id: string;
  readonly name: string;
  readonly generation: number;
  readonly outcome: "completed" | "failed";
  readonly finalText?: string | undefined;
  readonly error?: string | undefined;
  readonly warning?: string | undefined;
  readonly retained?: boolean | undefined;
  readonly retryAvailable?: boolean | undefined;
  readonly profile?: string | undefined;
  readonly remainingCandidateCount?: number | undefined;
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
  readonly actionAccepted?: boolean | undefined;
}

export type SubagentNotifier = (
  notification: SubagentNotification,
) => SubagentNotificationDelivery | undefined;

const MAX_NOTIFICATION_CHARS = 32 * 1024;

const clip = (value: string, maximumLength = MAX_NOTIFICATION_CHARS): string => {
  const sanitized = sanitizeDiagnosticContent(value, { maximumLength: maximumLength + 2 }).trim();
  if (sanitized.length <= maximumLength) return sanitized;
  return `${safeTextPrefix(sanitized, Math.max(0, maximumLength - 1)).trimEnd()}…`;
};

interface CompletionChunk {
  readonly content: string;
  readonly runs: ReadonlyArray<SubagentCompletionNotification>;
}

const completionBody = (run: SubagentCompletionNotification): string => {
  const warning = run.warning?.trim();
  const primary =
    run.outcome === "failed"
      ? `Error: ${run.error?.trim() || "Run failed without an error report."}`
      : run.finalText?.trim() || "Completed without a final report.";
  const retry = run.retryAvailable
    ? `Next: ${run.remainingCandidateCount ?? 1} configured ${run.profile ?? "profile"} candidate${(run.remainingCandidateCount ?? 1) === 1 ? " remains" : "s remain"}. Continue this exact task with subagent_lifecycle({ action: "retry", runIds: ["${run.id}"] }) before launching any generalist replacement.`
    : undefined;
  return [
    primary,
    warning && warning !== run.error?.trim() ? `Warning: ${warning}` : undefined,
    retry,
  ]
    .filter((value): value is string => value !== undefined)
    .join("\n\n");
};

const completionHeading = (run: SubagentCompletionNotification): string =>
  run.outcome === "failed"
    ? `failed outcome ${run.generation}`
    : `report ${run.generation}${run.retained ? " · retained" : ""}`;

const completionSection = (run: SubagentCompletionNotification): string =>
  `## ${run.name} (${run.id}) · ${completionHeading(run)}\n\n${completionBody(run)}`;

const boundedCompletion = (
  run: SubagentCompletionNotification,
  text: string,
  maximumLength: number,
): string => {
  if (text.length <= maximumLength) return clip(text, maximumLength);
  const noun = run.outcome === "failed" ? "Outcome" : "Report";
  const marker = `\n\n[${noun} truncated; use subagent_status or subagent_await for ${run.id}.]`;
  return `${clip(text, Math.max(0, maximumLength - marker.length))}${marker}`;
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
    const content = `${prefix}\n\n${boundedCompletion(run, completionBody(run), maximumBodyLength)}`;
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
    sections.push(boundedCompletion(run, unboundedSection, maximumSectionLength));
  }
  flush();
  return chunks;
};

export function makeHostNotifier(pi: ExtensionAPI): SubagentNotifier {
  return (notification) => {
    if (notification.type === "completed") {
      const deliveredCompletionKeys: string[] = [];
      for (const chunk of completionChunks(notification.runs)) {
        try {
          pi.sendMessage(
            {
              customType: "pi-subagents-completed",
              content: chunk.content,
              details: {
                version: 1,
                kind: "completed",
                total: chunk.runs.length,
                failed: chunk.runs.filter((run) => run.outcome === "failed").length,
                warnings: chunk.runs.filter((run) => Boolean(run.warning?.trim())).length,
              },
              display: true,
            },
            // Terminal outcomes intentionally join an active orchestration run or wake an idle
            // parent. Host acceptance is synchronous; model consumption may occur later.
            { deliverAs: "steer", triggerTurn: true },
          );
          for (const run of chunk.runs) deliveredCompletionKeys.push(`${run.id}:${run.generation}`);
        } catch {
          // Host acceptance may have happened before a throw. Leave this chunk and later chunks
          // unacknowledged so the service owns the uncertain retry.
          break;
        }
      }
      return { deliveredCompletionKeys };
    }

    const content = clip(
      `Subagent ${notification.name} (${notification.id}) is waiting for a parent reply.\n\nQuestion: ${notification.message}\n\nReply with subagent_reply({ runId: "${notification.id}", message: "..." }), then call subagent_await again.`,
    );
    try {
      pi.sendMessage(
        {
          customType: "pi-subagents-question",
          details: { version: 1, kind: "question" },
          content,
          display: true,
        },
        { deliverAs: "steer", triggerTurn: true },
      );
      return { actionAccepted: true };
    } catch {
      // Session shutdown can race with an actionable notification. The service retains it.
      return { actionAccepted: false };
    }
  };
}
