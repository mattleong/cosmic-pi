import type {
  AgentBeforeSettleEventResult,
  CustomMessageEntryDraft,
  ExtensionAPI,
  ExtensionContext,
  SessionBoundaryDraft,
} from "@earendil-works/pi-coding-agent";
import {
  clipText,
  countLabel,
  invokeHostCallback,
  notifyAtHostBoundary,
  registerSessionWake,
  sanitizeTerminalLine,
  type SessionWake,
} from "pi-cosmic-core";
import type { SubagentProjection, SubagentRunView } from "../run/model.ts";
import { isActiveRunState, SUBAGENT_ROOT_RUN_ID } from "../run/model.ts";
import { AGENT_MESSAGE_TYPE } from "./host-agent-messages.ts";
import { COMPLETION_MESSAGE_TYPE, QUESTION_MESSAGE_TYPE } from "./host-notifier.ts";

const QUESTION_REMINDER_MESSAGE_TYPE = "pi-subagents-question-reminder";
export const WAKE_MESSAGE_TYPE = "pi-subagents-wake";

const ROOT_NOTICE_TYPES: ReadonlySet<string> = new Set([
  COMPLETION_MESSAGE_TYPE,
  QUESTION_MESSAGE_TYPE,
  AGENT_MESSAGE_TYPE,
]);

const WAKE_TEXT =
  "Subagent updates or agent messages arrived while you were busy and are shown above. Act on them now: answer any question with subagent_send, review reports, reply to agent messages with agent_send only when it helps, and continue the task.";

interface ParentWakeHost {
  readonly projection: () => SubagentProjection;
  /** Waits for headless work to drain; undefined when subagents are inactive. */
  readonly drain: () => Promise<void> | undefined;
  /** Whether the parent session has neither a run nor a compaction in progress. */
  readonly isIdle: () => boolean;
  /** Runs `check` again shortly, outside the current host callback. */
  readonly later: (check: () => void) => void;
}

type PendingQuestion = SubagentRunView & {
  readonly question: NonNullable<SubagentRunView["question"]>;
};

const pendingQuestions = (projection: SubagentProjection): ReadonlyArray<PendingQuestion> =>
  projection.runs.filter(
    (run): run is PendingQuestion =>
      (run.parentRunId ?? SUBAGENT_ROOT_RUN_ID) === SUBAGENT_ROOT_RUN_ID &&
      run.question !== undefined &&
      run.state === "waiting_for_parent",
  );

const questionKey = (run: PendingQuestion): string => `${run.id}:${run.question.requestId}`;

const label = (run: SubagentRunView): string => clipText(sanitizeTerminalLine(run.name), 60);

const reminderText = (runs: ReadonlyArray<PendingQuestion>): string =>
  [
    runs.length === 1
      ? "A subagent is still waiting for your reply:"
      : `${runs.length} subagents are still waiting for your replies:`,
    ...runs.map((run) => `- ${run.name} (${run.id}): ${run.question.message}`),
    "Answer with subagent_send within the authority the user has already given you, or ask the user. Don't approve anything on the user's behalf.",
  ].join("\n\n");

const questionReminder = (
  runs: ReadonlyArray<PendingQuestion>,
): ReadonlyArray<CustomMessageEntryDraft> =>
  runs.length > 0
    ? [
        {
          type: "custom_message",
          customType: QUESTION_REMINDER_MESSAGE_TYPE,
          content: reminderText(runs),
          display: false,
        },
      ]
    : [];

const isHeadless = (ctx: ExtensionContext): boolean =>
  invokeHostCallback(() => ctx.mode === "print" || ctx.mode === "json", false);

const hasUi = (ctx: ExtensionContext): boolean => invokeHostCallback(() => ctx.hasUI, false);

const settleResult = (
  entries: ReadonlyArray<SessionBoundaryDraft>,
  added: ReadonlyArray<CustomMessageEntryDraft>,
  shouldContinue: boolean,
): AgentBeforeSettleEventResult | undefined =>
  shouldContinue ? { entries: [...entries, ...added], continue: true } : undefined;

/**
 * Owns when finished children may wake the root session, on the shared session wake: a notice
 * starts a turn only while the parent is idle, appends while it is busy and continues the settling
 * run, and holds after a user interrupt until the user's next prompt. A pending child question gets
 * one reminder before the turn settles, and a headless parent waits for running children instead of
 * exiting under them.
 */
export function registerParentWake(pi: ExtensionAPI, host: ParentWakeHost): SessionWake {
  const reminded = new Set<string>();
  const escalated = new Set<string>();

  // Question reminders belong to the branch the user left.
  pi.on("session_tree", () => {
    reminded.clear();
    escalated.clear();
  });

  return registerSessionWake(pi, {
    noticeTypes: ROOT_NOTICE_TYPES,
    wakeMessage: { customType: WAKE_MESSAGE_TYPE, content: WAKE_TEXT },
    isIdle: host.isIdle,
    later: host.later,
    onInterrupt: (ctx) => {
      const active = host.projection().runs.filter((run) => isActiveRunState(run.state)).length;
      if (active > 0 && hasUi(ctx))
        notifyAtHostBoundary(
          ctx,
          `${countLabel(active, "subagent")} still active; updates will wait for your next prompt`,
          "info",
        );
    },
    beforeSettle: (event, ctx, settle) => {
      const questions = pendingQuestions(host.projection());
      const live = new Set(questions.map(questionKey));
      for (const key of reminded) if (!live.has(key)) reminded.delete(key);
      for (const key of escalated) if (!live.has(key)) escalated.delete(key);
      const fresh = questions.filter((run) => !reminded.has(questionKey(run)));
      for (const run of fresh) reminded.add(questionKey(run));
      const reminder = questionReminder(fresh);
      if (fresh.length === 0) {
        const ignored = questions.filter((run) => !escalated.has(questionKey(run)));
        if (ignored.length > 0 && hasUi(ctx)) {
          for (const run of ignored) escalated.add(questionKey(run));
          notifyAtHostBoundary(
            ctx,
            ignored.length === 1 && ignored[0]
              ? `Subagent ${label(ignored[0])} is waiting for a reply`
              : `${ignored.length} subagents are waiting for replies`,
            "warning",
          );
        }
      }
      const result = settleResult(event.entries, reminder, settle.landed || fresh.length > 0);
      if (result || !isHeadless(ctx)) return result;
      if (!host.projection().runs.some((run) => isActiveRunState(run.state))) return undefined;
      // Notices delivered while draining are appended at this boundary, after the last reply.
      return host.drain()?.then(() => {
        const arrived = settle.takeOwed();
        // Drain may stop for a question before its notifier can acquire the delivery gate.
        // Continue with the same one-per-question reminder instead of exiting without showing it.
        const arrivedQuestions = settle.held()
          ? []
          : pendingQuestions(host.projection()).filter((run) => !reminded.has(questionKey(run)));
        for (const run of arrivedQuestions) reminded.add(questionKey(run));
        return settleResult(
          event.entries,
          questionReminder(arrivedQuestions),
          arrived || arrivedQuestions.length > 0,
        );
      });
    },
  });
}
