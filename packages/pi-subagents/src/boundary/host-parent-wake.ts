import type {
  AgentBeforeSettleEventResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  clipText,
  countLabel,
  invokeHostCallback,
  notifyAtHostBoundary,
  sanitizeTerminalLine,
} from "pi-cosmic-core";
import type { SubagentProjection, SubagentRunView } from "../run/model.ts";
import { isActiveRunState } from "../run/model.ts";

export const QUESTION_REMINDER_MESSAGE_TYPE = "pi-subagents-question-reminder";

export interface ParentWakeHost {
  readonly projection: () => SubagentProjection;
  /** Waits for headless work to drain; undefined when subagents are inactive. */
  readonly drain: () => Promise<void> | undefined;
}

export interface ParentWake {
  /** Whether a finished child may start a parent turn now. */
  readonly mayStartTurn: () => boolean;
  /** Holds wakes for the rest of this session, as it shuts down. */
  readonly hold: () => void;
}

type PendingQuestion = SubagentRunView & {
  readonly question: NonNullable<SubagentRunView["question"]>;
};

const pendingQuestions = (projection: SubagentProjection): ReadonlyArray<PendingQuestion> =>
  projection.runs.filter(
    (run): run is PendingQuestion =>
      run.parentRunId === undefined &&
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
    "Reply with subagent_reply within the authority the user has already given you, or ask the user. Don't approve anything on the user's behalf.",
  ].join("\n\n");

const isHeadless = (ctx: ExtensionContext): boolean =>
  invokeHostCallback(() => ctx.mode === "print" || ctx.mode === "json", false);

const hasUi = (ctx: ExtensionContext): boolean => invokeHostCallback(() => ctx.hasUI, false);

/**
 * Owns when finished children may wake the root session. A user interrupt holds wakes until the
 * user's next prompt; a pending child question gets one reminder before the turn settles; and a
 * headless parent waits for running children instead of exiting under them.
 */
export function registerParentWake(pi: ExtensionAPI, host: ParentWakeHost): ParentWake {
  let held = false;
  const reminded = new Set<string>();
  const escalated = new Set<string>();

  pi.on("agent_settled", (event, ctx) => {
    if (!event.aborted) return;
    held = true;
    const active = host.projection().runs.filter((run) => isActiveRunState(run.state)).length;
    if (active > 0 && hasUi(ctx))
      notifyAtHostBoundary(
        ctx,
        `${countLabel(active, "subagent")} still active; updates will wait for your next prompt`,
        "info",
      );
  });

  pi.on("before_agent_start", (event) => {
    if (event.messageType === "user") held = false;
  });

  pi.on("session_start", () => {
    held = false;
  });

  pi.on(
    "agent_before_settle",
    (event, ctx): AgentBeforeSettleEventResult | Promise<undefined> | undefined => {
      if (event.outcome !== "completed") return undefined;
      const questions = pendingQuestions(host.projection());
      const live = new Set(questions.map(questionKey));
      for (const key of reminded) if (!live.has(key)) reminded.delete(key);
      for (const key of escalated) if (!live.has(key)) escalated.delete(key);
      const fresh = questions.filter((run) => !reminded.has(questionKey(run)));
      if (fresh.length > 0) {
        for (const run of fresh) reminded.add(questionKey(run));
        return {
          entries: [
            {
              type: "custom_message",
              customType: QUESTION_REMINDER_MESSAGE_TYPE,
              content: reminderText(fresh),
              display: false,
            },
          ],
          continue: true,
        };
      }
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
      if (!isHeadless(ctx)) return undefined;
      if (!host.projection().runs.some((run) => isActiveRunState(run.state))) return undefined;
      return host.drain()?.then(() => undefined);
    },
  );

  return {
    mayStartTurn: () => !held,
    hold: () => {
      held = true;
    },
  };
}
