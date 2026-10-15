import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Predicate from "effect/Predicate";
import {
  clipText,
  invokeHostCallback,
  sanitizeDiagnosticContent,
  sanitizeTerminalLine,
} from "pi-cosmic-core";
import type { ArchivedReport, ReportArchive } from "./report-archive.ts";

export interface SubagentCompletionNotification {
  readonly id: string;
  readonly name: string;
  readonly generation: number;
  readonly outcome: "completed" | "failed";
  readonly finalText?: string | undefined;
  readonly error?: string | undefined;
  readonly warning?: string | undefined;
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

export const sanitizeNotificationContent = (
  value: string,
  maximumLength = Number.POSITIVE_INFINITY,
): string => sanitizeDiagnosticContent(value, { maximumLength }).trim();

const clip = (value: string, maximumLength = MAX_NOTIFICATION_CHARS): string =>
  clipText(sanitizeNotificationContent(value, maximumLength + 2), maximumLength);

interface CompletionChunk {
  readonly content: string;
  readonly runs: ReadonlyArray<SubagentCompletionNotification>;
}

const ERROR_LABELLED = /^(?:[A-Z][A-Za-z]*)?Error\b/u;

const failureText = (error: string | undefined): string => {
  const text = error?.trim();
  if (!text) return "Error: Run failed without an error report.";
  return ERROR_LABELLED.test(text) ? text : `Error: ${text}`;
};

const REPORT_PREVIEW_CHARS = 4_000;

// Keeps whole lines where possible so the preview never ends mid-sentence without a marker.
const reportPreview = (text: string): string => {
  const cut = text.slice(0, REPORT_PREVIEW_CHARS);
  const lineEnd = cut.lastIndexOf("\n");
  return lineEnd > REPORT_PREVIEW_CHARS / 2 ? cut.slice(0, lineEnd) : cut;
};

const reportText = (report: string, archived: ArchivedReport | undefined): string => {
  if (!archived) return report;
  if (report.length <= REPORT_PREVIEW_CHARS) return `${report}\n\n[Full report: ${archived.path}]`;
  const preview = reportPreview(report);
  return `${preview}\n\n[Preview: ${preview.length.toLocaleString("en-US")} of ${report.length.toLocaleString("en-US")} characters. Full report (${archived.lines} lines): ${archived.path}]`;
};

const completionBody = (run: SubagentCompletionNotification, archived?: ArchivedReport): string => {
  const warning = run.warning?.trim();
  const report = run.finalText?.trim() ?? "";
  const primary =
    run.outcome === "failed"
      ? failureText(run.error)
      : report
        ? reportText(report, archived)
        : "Completed without a final report.";
  const retry = run.retryAvailable
    ? `Next: ${run.remainingCandidateCount ?? 1} configured ${run.profile ?? "profile"} candidate${(run.remainingCandidateCount ?? 1) === 1 ? " remains" : "s remain"}. Continue this exact task with subagent_lifecycle({ action: "retry", runIds: ["${run.id}"] }) before launching any generalist replacement.`
    : undefined;
  return [
    primary,
    warning && warning !== run.error?.trim() ? `Warning: ${warning}` : undefined,
    retry,
  ]
    .filter(Predicate.isNotUndefined)
    .join("\n\n");
};

const completionHeading = (run: SubagentCompletionNotification): string =>
  run.outcome === "failed" ? `failed outcome ${run.generation}` : `report ${run.generation}`;

const completionSection = (
  run: SubagentCompletionNotification,
  archived: ArchivedReport | undefined,
): string =>
  `## ${run.name} (${run.id}) · ${completionHeading(run)}\n\n${completionBody(run, archived)}`;

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
  archive: ReportArchive | undefined,
): ReadonlyArray<CompletionChunk> => {
  const archived = new Map<SubagentCompletionNotification, ArchivedReport>();
  for (const run of runs) {
    const text = run.outcome === "completed" ? run.finalText?.trim() : undefined;
    const saved = text ? archive?.({ id: run.id, generation: run.generation, text }) : undefined;
    if (saved) archived.set(run, saved);
  }
  const [single] = runs;
  if (runs.length === 1 && single !== undefined) {
    const prefix =
      single.outcome === "failed"
        ? `Background subagent ${single.name} (${single.id}) failed.`
        : `Background subagent ${single.name} (${single.id}) completed.`;
    const maximumBodyLength = Math.max(0, MAX_NOTIFICATION_CHARS - prefix.length - 2);
    const content = `${prefix}\n\n${boundedCompletion(single, completionBody(single, archived.get(single)), maximumBodyLength)}`;
    return [{ content: clip(content), runs: [single] }];
  }

  const chunks: CompletionChunk[] = [];
  let chunkRuns: SubagentCompletionNotification[] = [];
  let sections: string[] = [];
  const failed = runs.filter((run) => run.outcome === "failed").length;
  const completed = runs.length - failed;
  const headerFor = (chunkIndex: number): string => {
    const continuation = chunkIndex === 0 ? "" : ` (continued ${chunkIndex + 1})`;
    const outcomes = [
      completed > 0 ? `${completed} completed` : undefined,
      failed > 0 ? `${failed} failed` : undefined,
    ]
      .filter(Predicate.isNotUndefined)
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

  const room = () =>
    MAX_NOTIFICATION_CHARS -
    headerFor(chunks.length).length -
    2 -
    sections.join("\n\n").length -
    (sections.length > 0 ? 2 : 0);
  for (const run of runs) {
    const section = completionSection(run, archived.get(run));
    if (sections.length > 0 && section.length > room()) flush();
    chunkRuns.push(run);
    sections.push(boundedCompletion(run, section, Math.max(0, room())));
  }
  flush();
  return chunks;
};

const questionContent = (
  notification: Extract<SubagentNotification, { readonly type: "question" }>,
): string => {
  const reply = `subagent_reply({ runId: "${notification.id}", message: "..." })`;
  return `Subagent ${notification.name} (${notification.id}) is waiting for a parent reply.\n\nQuestion: ${notification.message}\n\nReply with ${reply}, then call subagent_await again.`;
};

const displayName = (name: string): string => clipText(sanitizeTerminalLine(name), 60);

export const COMPLETION_MESSAGE_TYPE = "pi-subagents-completed";
export const QUESTION_MESSAGE_TYPE = "pi-subagents-question";

const sendNotice = (
  pi: ExtensionAPI,
  message: Omit<Parameters<ExtensionAPI["sendMessage"]>[0], "display">,
  triggerTurn: boolean,
): boolean =>
  invokeHostCallback(() => {
    pi.sendMessage({ ...message, display: true }, { deliverAs: "steer", triggerTurn });
    return true;
  }, false);

/** Decides whether a notice starts a parent turn, and learns when one was appended without one. */
export interface NoticeDelivery {
  /** Runs `send` once; it starts a turn only when told to and returns whether Pi accepted it. */
  readonly deliver: (send: (startTurn: boolean) => boolean) => boolean;
}

const STARTS_TURN: NoticeDelivery = { deliver: (send) => send(true) };

export interface HostNotifierOptions {
  /** The parent wake policy; without one every notice starts or steers a turn. */
  readonly delivery?: NoticeDelivery;
  /** The current session's report archive, if subagents are active. */
  readonly archive?: () => ReportArchive | undefined;
}

export function hostNotifier(
  pi: ExtensionAPI,
  options: HostNotifierOptions = {},
): SubagentNotifier {
  const delivery = options.delivery ?? STARTS_TURN;
  return (notification) => {
    if (notification.type === "completed") {
      const chunks = completionChunks(notification.runs, options.archive?.());
      const deliveredCompletionKeys: string[] = [];
      delivery.deliver((startTurn) => {
        for (const [index, chunk] of chunks.entries()) {
          // Only the last chunk may start the turn, so the earlier ones are already in place.
          const accepted = sendNotice(
            pi,
            {
              customType: COMPLETION_MESSAGE_TYPE,
              content: chunk.content,
              details: {
                version: 1,
                kind: "completed",
                total: chunk.runs.length,
                failed: chunk.runs.filter((run) => run.outcome === "failed").length,
                warnings: chunk.runs.filter((run) => Boolean(run.warning?.trim())).length,
                ...(chunk.runs.length === 1 &&
                  chunk.runs[0] !== undefined && { name: displayName(chunk.runs[0].name) }),
              },
            },
            startTurn && index === chunks.length - 1,
          );
          if (!accepted) break;
          for (const run of chunk.runs) deliveredCompletionKeys.push(`${run.id}:${run.generation}`);
        }
        return deliveredCompletionKeys.length > 0;
      });
      return { deliveredCompletionKeys };
    }
    return {
      actionAccepted: delivery.deliver((startTurn) =>
        sendNotice(
          pi,
          {
            customType: QUESTION_MESSAGE_TYPE,
            details: { version: 1, kind: "question", name: displayName(notification.name) },
            content: clip(questionContent(notification)),
          },
          startTurn,
        ),
      ),
    };
  };
}
