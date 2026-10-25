import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Predicate from "effect/Predicate";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { clipText } from "pi-cosmic-core/display";
import { invokeHostCallback } from "pi-cosmic-core/host-session";
import { sanitizeDiagnosticContent, sanitizeTerminalLine } from "pi-cosmic-core/security";
import { type SessionWakeDelivery } from "pi-cosmic-core/host-wake";
import { MAX_NOTIFICATION_CHARS } from "../run/limits.ts";
import type {
  SubagentNextCandidate,
  SubagentReportArchive,
  SubagentReportTruncation,
  SubagentWorkspaceOutcome,
} from "../run/model.ts";
import { indentQuestionLines, proposalGuidance } from "../tools/format.ts";
import {
  formatRunBlocks,
  nextCandidateAction,
  wholeSavedReport,
  withInlineReports,
  type InlineReport,
  type RunBlock,
} from "../tools/run-block.ts";
import { runStateLabel } from "../ui/run-state.ts";

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
  /** The failure's file, saved at settlement when the error is longer than its preview. */
  readonly errorArchive?: SubagentReportArchive | undefined;
  readonly warning?: string | undefined;
  readonly profile?: string | undefined;
  /** A failure's next frozen route candidate. */
  readonly nextCandidate?: SubagentNextCandidate | undefined;
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

const sanitizeNotificationContent = (
  value: string,
  maximumLength = Number.POSITIVE_INFINITY,
): string => Str.trim(sanitizeDiagnosticContent(value, { maximumLength }));

const clip = (value: string, maximumLength = MAX_NOTIFICATION_CHARS): string =>
  clipText(sanitizeNotificationContent(value, maximumLength + 2), maximumLength);

const workspaceAction = (run: SubagentCompletionNotification): string | undefined => {
  const { workspaceId, workspaceOutcome } = run;
  if (workspaceId === undefined) return undefined;
  return run.outcome === "failed"
    ? `Workspace: ${workspaceId} is kept.`
    : `Workspace: ${proposalGuidance(workspaceId, workspaceOutcome)}`;
};

/** A finished run's block, the same bounded block an await shows. */
export const completionBlock = (run: SubagentCompletionNotification): RunBlock => {
  const warning = Str.trim(run.warning ?? "");
  const error = Str.trim(run.error ?? "");
  return {
    id: run.id,
    name: run.name,
    facts: [
      runStateLabel(run.outcome),
      run.profile,
      run.generation > 1
        ? `${run.outcome === "failed" ? "outcome" : "report"} ${run.generation}`
        : undefined,
    ],
    outcome:
      run.outcome === "failed"
        ? {
            kind: "failure",
            text: error || "Run failed without an error report.",
            archive: run.errorArchive,
          }
        : {
            kind: "report",
            text: run.finalText,
            archive: run.reportArchive,
            truncation: run.finalTextTruncation,
          },
    actions: {
      candidate: nextCandidateAction(run.nextCandidate),
      workspace: workspaceAction(run),
      warning: warning && warning !== error ? warning : undefined,
    },
  };
};

/** A completed run's whole retained report, which a notice repeats when it fits. */
export const inlineCompletionReport = (
  run: SubagentCompletionNotification,
): InlineReport | undefined => (run.outcome === "completed" ? wholeSavedReport(run) : undefined);

/**
 * One notice for the whole batch: every run's block fits, so nothing is chunked or cut, and the
 * whole reports that fit what remains follow.
 */
const completionContent = (runs: ReadonlyArray<SubagentCompletionNotification>): string => {
  const failed = Arr.filter(runs, (run) => run.outcome === "failed").length;
  const completed = runs.length - failed;
  const [single] = runs;
  const heading =
    runs.length === 1 && single !== undefined
      ? `Background subagent ${single.outcome}.`
      : `${runs.length} background subagents finished · ${Arr.join(
          Arr.filter(
            [
              completed > 0 ? `${completed} completed` : undefined,
              failed > 0 ? `${failed} failed` : undefined,
            ],
            Predicate.isNotUndefined,
          ),
          " · ",
        )}.`;
  return clip(
    withInlineReports(
      formatRunBlocks([heading], Arr.map(runs, completionBlock)),
      Arr.map(runs, inlineCompletionReport),
      MAX_NOTIFICATION_CHARS,
    ),
  );
};

const questionContent = (
  notification: Extract<SubagentNotification, { readonly type: "question" }>,
): string => {
  const reply = `agent_send({ to: "${notification.id}", message: "..." })`;
  return `Subagent ${notification.name} (${notification.id}) is waiting for a parent reply.\n\nQuestion:\n${indentQuestionLines(notification.message, "  ")}\n\nIf it isn't answered yet, reply with ${reply}, then call agent_await again.`;
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
      const { runs } = notification;
      let accepted = false;
      delivery.deliver((startTurn) => {
        accepted = sendNotice(
          pi,
          {
            customType: COMPLETION_MESSAGE_TYPE,
            content: completionContent(runs),
            details: {
              version: 1,
              kind: "completed",
              ids: Arr.map(runs, (run) => run.id),
              total: runs.length,
              failed: Arr.filter(runs, (run) => run.outcome === "failed").length,
              warnings: Arr.filter(runs, (run) => Boolean(Str.trim(run.warning ?? ""))).length,
              ...(runs.length === 1 &&
                runs[0] !== undefined && { name: displayName(runs[0].name) }),
            },
          },
          startTurn,
        );
        return accepted;
      });
      return {
        deliveredCompletionKeys: accepted
          ? Arr.map(runs, (run) => `${run.id}:${run.generation}`)
          : [],
      };
    }
    return {
      actionAccepted:
        delivery.deliver((startTurn) =>
          sendNotice(
            pi,
            {
              customType: QUESTION_MESSAGE_TYPE,
              details: {
                version: 1,
                kind: "question",
                id: notification.id,
                name: displayName(notification.name),
              },
              content: clip(questionContent(notification)),
            },
            startTurn,
          ),
        ) !== "refused",
    };
  };
}
