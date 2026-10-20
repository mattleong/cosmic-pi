import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Predicate from "effect/Predicate";
import {
  clipText,
  invokeHostCallback,
  sanitizeDiagnosticContent,
  sanitizeTerminalLine,
  type SessionWakeDelivery,
} from "pi-cosmic-core";
import { MAX_NOTIFICATION_CHARS } from "../run/limits.ts";
import type {
  SubagentReportArchive,
  SubagentReportTruncation,
  SubagentWorkspaceOutcome,
} from "../run/model.ts";
import { indentQuestionLines, proposalGuidance } from "../tools/format.ts";
import { formatRunBlocks, lineageAction, type RunBlock } from "../tools/run-block.ts";
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

const sanitizeNotificationContent = (
  value: string,
  maximumLength = Number.POSITIVE_INFINITY,
): string => sanitizeDiagnosticContent(value, { maximumLength }).trim();

const clip = (value: string, maximumLength = MAX_NOTIFICATION_CHARS): string =>
  clipText(sanitizeNotificationContent(value, maximumLength + 2), maximumLength);

const retryAction = (run: SubagentCompletionNotification): string | undefined => {
  if (!run.retryAvailable) return undefined;
  const remaining = run.remainingCandidateCount ?? 1;
  return `Route retry: agent_lifecycle({ action: "retry", runIds: [${JSON.stringify(run.id)}] }) continues this task (${remaining} candidate${remaining === 1 ? "" : "s"} left); prefer it to a replacement.`;
};

const workspaceAction = (run: SubagentCompletionNotification): string | undefined => {
  const { workspaceId, workspaceOutcome } = run;
  if (workspaceId === undefined) return undefined;
  return run.outcome === "failed"
    ? `Workspace: ${workspaceId} is kept.`
    : `Workspace: ${proposalGuidance(workspaceId, workspaceOutcome)}`;
};

/** A finished run's block, the same bounded block an await shows. */
export const completionBlock = (run: SubagentCompletionNotification): RunBlock => {
  const warning = run.warning?.trim();
  const error = run.error?.trim();
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
            text:
              error === undefined || error.length === 0
                ? "Run failed without an error report."
                : error,
            archive: run.errorArchive,
          }
        : {
            kind: "report",
            text: run.finalText,
            archive: run.reportArchive,
            truncation: run.finalTextTruncation,
          },
    actions: {
      retry: retryAction(run),
      workspace: workspaceAction(run),
      lineage: lineageAction(run),
      warning: warning && warning !== error ? warning : undefined,
    },
  };
};

/** One notice for the whole batch: every run's block fits, so nothing is chunked or cut. */
const completionContent = (runs: ReadonlyArray<SubagentCompletionNotification>): string => {
  const failed = runs.filter((run) => run.outcome === "failed").length;
  const completed = runs.length - failed;
  const [single] = runs;
  const heading =
    runs.length === 1 && single !== undefined
      ? `Background subagent ${single.outcome}.`
      : `${runs.length} background subagents finished · ${[
          completed > 0 ? `${completed} completed` : undefined,
          failed > 0 ? `${failed} failed` : undefined,
        ]
          .filter(Predicate.isNotUndefined)
          .join(" · ")}.`;
  return clip(formatRunBlocks([heading], runs.map(completionBlock)));
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
              total: runs.length,
              failed: runs.filter((run) => run.outcome === "failed").length,
              warnings: runs.filter((run) => Boolean(run.warning?.trim())).length,
              ...(runs.length === 1 &&
                runs[0] !== undefined && { name: displayName(runs[0].name) }),
            },
          },
          startTurn,
        );
        return accepted;
      });
      return {
        deliveredCompletionKeys: accepted ? runs.map((run) => `${run.id}:${run.generation}`) : [],
      };
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
