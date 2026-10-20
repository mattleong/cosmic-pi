import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Predicate from "effect/Predicate";
import {
  clipText,
  invokeHostCallback,
  sanitizeDiagnosticContent,
  sanitizeTerminalLine,
  type SessionWakeDelivery,
} from "pi-cosmic-core";
import { resumedByText } from "../run/agent-messaging.ts";
import type {
  SubagentReportArchive,
  SubagentReportTruncation,
  SubagentWorkspaceOutcome,
} from "../run/model.ts";
import { reportFileText, unsavedReportNote } from "../run/state.ts";
import { proposalDiffStatLines, proposalGuidance } from "../tools/format.ts";

export interface SubagentCompletionNotification {
  readonly id: string;
  readonly name: string;
  readonly generation: number;
  readonly outcome: "completed" | "failed";
  readonly finalText?: string | undefined;
  /** `finalText` holds only the start of a longer report. */
  readonly finalTextTruncation?: SubagentReportTruncation | undefined;
  /** The report's file, saved at settlement; absent when it couldn't be written. */
  readonly reportArchive?: SubagentReportArchive | undefined;
  readonly error?: string | undefined;
  readonly warning?: string | undefined;
  /** The agent whose message resumed this run; the report still comes to its parent. */
  readonly resumedBy?: string | undefined;
  readonly retryAvailable?: boolean | undefined;
  readonly profile?: string | undefined;
  readonly remainingCandidateCount?: number | undefined;
  /** A worktree writer's workspace; its outcome is known once the writer's cleanup settled. */
  readonly workspaceId?: string | undefined;
  readonly workspaceOutcome?: SubagentWorkspaceOutcome | undefined;
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

const sanitizeNotificationContent = (
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

const workspaceText = (run: SubagentCompletionNotification): string | undefined => {
  const { workspaceId, workspaceOutcome: outcome } = run;
  if (workspaceId === undefined) return undefined;
  if (run.outcome === "failed") return `Workspace ${workspaceId} is kept.`;
  const files = outcome?.status === "proposal" ? proposalDiffStatLines(outcome) : [];
  return [proposalGuidance(workspaceId, outcome), ...files.map((line) => `  ${line}`)].join("\n");
};

const UNSAVED_REPORT_CUT_MARKER = "\n\n[Report cut to fit this notice; no file holds the rest.]";

/**
 * A run's notice body within `maximumLength`. A report without a file is the only copy the parent
 * gets, so it alone gives up room to the lines around it.
 */
const completionBody = (run: SubagentCompletionNotification, maximumLength: number): string => {
  const warning = run.warning?.trim();
  const retry = run.retryAvailable
    ? `Next: ${run.remainingCandidateCount ?? 1} configured ${run.profile ?? "profile"} candidate${(run.remainingCandidateCount ?? 1) === 1 ? " remains" : "s remain"}. Continue this exact task with agent_lifecycle({ action: "retry", runIds: ["${run.id}"] }) before launching any generalist replacement.`
    : undefined;
  // The workspace outcome and resumer lead so that truncating a long report can't drop them.
  const body = (primary: string): string =>
    [
      resumedByText(run),
      workspaceText(run),
      primary,
      warning && warning !== run.error?.trim() ? `Warning: ${warning}` : undefined,
      retry,
    ]
      .filter(Predicate.isNotUndefined)
      .join("\n\n");
  if (run.outcome === "failed") return body(failureText(run.error));
  const report = run.finalText?.trim() ?? "";
  if (!report) return body("Completed without a final report.");
  if (run.reportArchive) return body(reportFileText(run.reportArchive));
  const note = `${unsavedReportNote(run.finalTextTruncation)}\n\n`;
  const room = maximumLength - body(note).length;
  return body(
    `${note}${report.length <= room ? report : `${clip(report, Math.max(0, room - UNSAVED_REPORT_CUT_MARKER.length))}${UNSAVED_REPORT_CUT_MARKER}`}`,
  );
};

const completionHeading = (run: SubagentCompletionNotification): string =>
  run.outcome === "failed" ? `failed outcome ${run.generation}` : `report ${run.generation}`;

const completionSection = (run: SubagentCompletionNotification, maximumLength: number): string => {
  const heading = `## ${run.name} (${run.id}) · ${completionHeading(run)}\n\n`;
  return `${heading}${completionBody(run, maximumLength - heading.length)}`;
};

const boundedCompletion = (
  run: SubagentCompletionNotification,
  text: string,
  maximumLength: number,
): string => {
  if (text.length <= maximumLength) return clip(text, maximumLength);
  // agent_read gives a failure and a report's file; a report without a file has no other copy.
  const recovery =
    run.outcome === "failed" || run.reportArchive
      ? `agent_read shows ${run.id} in full`
      : "no report file holds the rest";
  const marker = `\n\n[Notice truncated; ${recovery}.]`;
  return `${clip(text, Math.max(0, maximumLength - marker.length))}${marker}`;
};

const completionChunks = (
  runs: ReadonlyArray<SubagentCompletionNotification>,
): ReadonlyArray<CompletionChunk> => {
  const [single] = runs;
  if (runs.length === 1 && single !== undefined) {
    const prefix =
      single.outcome === "failed"
        ? `Background subagent ${single.name} (${single.id}) failed.`
        : `Background subagent ${single.name} (${single.id}) completed.`;
    const maximumBodyLength = Math.max(0, MAX_NOTIFICATION_CHARS - prefix.length - 2);
    const body = completionBody(single, maximumBodyLength);
    const content = `${prefix}\n\n${boundedCompletion(single, body, maximumBodyLength)}`;
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
    // Sized for a fresh chunk, whose continued header is never shorter than the current one.
    const section = completionSection(
      run,
      MAX_NOTIFICATION_CHARS - headerFor(chunks.length + 1).length - 2,
    );
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
  const reply = `agent_send({ to: "${notification.id}", message: "..." })`;
  return `Subagent ${notification.name} (${notification.id}) is waiting for a parent reply.\n\nQuestion: ${notification.message}\n\nReply with ${reply}, then call agent_await again.`;
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
  /** Runs `send` once; it starts a turn only when told to. Reports how Pi took the notice. */
  readonly deliver: (send: (startTurn: boolean) => boolean) => SessionWakeDelivery;
}

const STARTS_TURN: NoticeDelivery = {
  deliver: (send) => (send(true) ? "woken" : "refused"),
};

interface HostNotifierOptions {
  /** The parent wake policy; without one every notice starts or steers a turn. */
  readonly delivery?: NoticeDelivery;
}

export function hostNotifier(
  pi: ExtensionAPI,
  options: HostNotifierOptions = {},
): SubagentNotifier {
  const delivery = options.delivery ?? STARTS_TURN;
  return (notification) => {
    if (notification.type === "completed") {
      const chunks = completionChunks(notification.runs);
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
      actionAccepted:
        delivery.deliver((startTurn) =>
          sendNotice(
            pi,
            {
              customType: QUESTION_MESSAGE_TYPE,
              details: { version: 1, kind: "question", name: displayName(notification.name) },
              content: clip(questionContent(notification)),
            },
            startTurn,
          ),
        ) !== "refused",
    };
  };
}
