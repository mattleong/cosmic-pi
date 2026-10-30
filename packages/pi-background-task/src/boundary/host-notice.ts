import type {
  AgentBeforeSettleEvent,
  AgentBeforeSettleEventResult,
  CustomMessageEntryDraft,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Match from "effect/Match";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { clipText, countLabel, formatDuration } from "pi-cosmic-core/display";
import { deliverAgentMessage } from "pi-cosmic-core/host-agent-messages";
import { originFromDetails, registerMessageOrigins } from "pi-cosmic-core/host-message-origin";
import { invokeHostCallback } from "pi-cosmic-core/host-session";
import { hasUnansweredNotice, registerSessionWake } from "pi-cosmic-core/host-wake";
import { sanitizeDiagnosticContent, sanitizeTerminalLine } from "pi-cosmic-core/security";
import type { BackgroundTaskNotice, BackgroundTaskSnapshot } from "../task/model.ts";
import {
  MAX_NOTICE_TAIL_CHARS,
  TASK_NOTICE_MESSAGE_TYPE,
  taskNoticeDetails,
} from "../task/notice.ts";
import { recentOutput } from "../tools/log-page.ts";

const NOTICE_TYPES: ReadonlySet<string> = new Set([TASK_NOTICE_MESSAGE_TYPE]);
const WAKE_MESSAGE_TYPE = "pi-background-task-wake";
const WAKE_TEXT =
  "Background tasks finished while you were busy; their notices are shown above. Act on them now and continue the task.";

const RUN_END_REMINDER_TYPE = "pi-background-task-run-end-reminder";

const TASK_OUTPUT = {
  author: "other",
  relays: "a background task's exit status and output",
} as const;

/**
 * Marks every notice and reminder this extension keeps in model context, so the model can tell them
 * from text the user typed; a notice names the task whose output it relays. Registers at factory
 * time, in root and subagent sessions alike.
 */
export function registerTaskMessageOrigins(pi: ExtensionAPI): void {
  registerMessageOrigins(pi, {
    extension: "pi-background-task",
    types: {
      [TASK_NOTICE_MESSAGE_TYPE]: originFromDetails(
        Schema.Struct({ task: Schema.Struct({ id: Schema.String }) }),
        ({ task }) => ({
          author: "other",
          relays: `the exit status and output of background task ${task.id}`,
        }),
        TASK_OUTPUT,
      ),
      [WAKE_MESSAGE_TYPE]: { author: "extension" },
      [RUN_END_REMINDER_TYPE]: { author: "extension" },
    },
  });
}

const MAX_NOTICE_CHARS = 8_000;
const MAX_COMMAND_CHARS = 300;
const MAX_REMINDED_TASKS = 8;

const finish = (task: BackgroundTaskSnapshot): string =>
  Match.value(task.state).pipe(
    Match.when("exited", () => "exited with code 0"),
    Match.when("failed", () => {
      if (task.error) return `couldn't start: ${sanitizeTerminalLine(task.error)}`;
      if (task.signal) return `was killed by ${sanitizeTerminalLine(task.signal)}`;
      return Predicate.isNumber(task.exitCode)
        ? `failed with exit code ${task.exitCode}`
        : "failed without an exit code";
    }),
    Match.when("timed_out", () => "timed out and was stopped"),
    Match.when("stopped", () => "was stopped by the user"),
    Match.orElse((state) => `is ${state}`),
  );

const taskLabel = (task: BackgroundTaskSnapshot): string => {
  const name = task.name === undefined ? "" : sanitizeTerminalLine(task.name);
  return name ? `${JSON.stringify(name)} (${task.id})` : task.id;
};

/**
 * What the agent reads when a task finishes: which task, how and after how long it ended, the
 * failure's cause, and its newest output, then how to read more while the task is still listed.
 * Credentials it recognizes are redacted and the whole notice is bounded.
 */
export const taskNoticeContent = ({ task, recent, retained }: BackgroundTaskNotice): string => {
  const duration =
    task.endedAt === undefined ? "" : ` after ${formatDuration(task.endedAt - task.startedAt)}`;
  const output = Str.trimEnd(recentOutput(recent));
  const cause = task.failureCause === undefined ? "" : sanitizeTerminalLine(task.failureCause);
  const content = Arr.join(
    Arr.filter(
      [
        `Background task ${taskLabel(task)} ${finish(task)}${duration}.`,
        `Command: ${clipText(sanitizeTerminalLine(task.command), MAX_COMMAND_CHARS)}`,
        cause ? `Cause: ${cause}` : undefined,
        output ? `Recent output:\n${output}` : "It printed no output.",
        retained
          ? `For more output, call background_task with action "logs" and id "${task.id}".`
          : "Its record was already cleared, so no more output can be read.",
      ],
      Predicate.isString,
    ),
    "\n",
  );
  return sanitizeDiagnosticContent(content, { maximumLength: MAX_NOTICE_CHARS });
};

/** The stored notice: the text the agent reads and redacted details for its renderer. */
export const taskNoticeMessage = (notice: BackgroundTaskNotice) => ({
  customType: TASK_NOTICE_MESSAGE_TYPE,
  content: taskNoticeContent(notice),
  details: taskNoticeDetails(
    notice.task,
    sanitizeDiagnosticContent(Str.trimEnd(recentOutput(notice.recent)), {
      maximumLength: MAX_NOTICE_TAIL_CHARS,
    }),
  ),
});

export interface TaskNoticeHost {
  /** Whether the session has neither a run nor a compaction in progress. */
  readonly isIdle: () => boolean;
  /** Runs `check` again shortly, outside the current host callback. */
  readonly later: (check: () => void) => void;
}

/**
 * Sends a finished task's notice. `isCurrent` is checked again in the callback that sends it, so a
 * retired runtime never delivers into its successor.
 */
export type TaskNoticeDelivery = (notice: BackgroundTaskNotice, isCurrent: () => boolean) => void;

/**
 * Owns how exit notices reach the agent, on the shared session wake: an idle session starts a
 * turn, a busy one reads the notice before its turn settles, and wakes wait behind an open dialog
 * or a user interrupt until the user's next prompt. Registers at factory time.
 */
export function registerTaskNoticeDelivery(
  pi: ExtensionAPI,
  host: TaskNoticeHost,
): TaskNoticeDelivery {
  const wake = registerSessionWake(pi, {
    noticeTypes: NOTICE_TYPES,
    wakeMessage: { customType: WAKE_MESSAGE_TYPE, content: WAKE_TEXT },
    isIdle: host.isIdle,
    later: host.later,
    holdDuringDialogs: true,
  });
  return (notice, isCurrent) => {
    deliverAgentMessage(pi, wake, taskNoticeMessage(notice), isCurrent);
  };
}

/**
 * What a settling subagent reads while tasks its run's end would stop are still running. Its
 * report is its last message, so it has to give the whole report again after acting on this.
 */
const runEndReminder = (tasks: ReadonlyArray<BackgroundTaskSnapshot>): CustomMessageEntryDraft => {
  const listed = Arr.map(Arr.take(tasks, MAX_REMINDED_TASKS), taskLabel);
  const unlisted = tasks.length - listed.length;
  const names = Arr.join(unlisted > 0 ? [...listed, `${unlisted} more`] : listed, ", ");
  return {
    type: "custom_message",
    customType: RUN_END_REMINDER_TYPE,
    content: sanitizeDiagnosticContent(
      `Your run is about to end, which stops ${countLabel(tasks.length, "background task")} still running: ${names}. No notice can reach you after it ends. Wait for any task whose result your report needs and stop the rest, then reply with your complete final report, because your parent receives only your last message.`,
      { maximumLength: MAX_NOTICE_CHARS },
    ),
    display: false,
  };
};

export interface SubagentTaskSettleHost {
  /**
   * The current activation's active tasks, read synchronously: Pi commits a settle handler's
   * entries before it checks for an abort and gives the handler no abort signal, so a decision
   * that waited could leave the reminder in a run paused meanwhile.
   */
  readonly activeTasks: () => ReadonlyArray<BackgroundTaskSnapshot>;
}

/**
 * Exit notices in a subagent's own Pi session, which never start a turn. An idle subagent's run is
 * settling, reported, or paused for its parents, and a turn started then would replace its report
 * or resume it without them. The notice is appended for its next turn instead; a busy subagent's
 * settling run continues so it reads the notice before it reports. A completed run that settles
 * with tasks still starting or running, which its end would stop, continues once per prompt with a
 * reminder to wait for or stop them, so a run that keeps them still reports. Registers at factory
 * time.
 */
export function registerSubagentTaskNoticeDelivery(
  pi: ExtensionAPI,
  host: SubagentTaskSettleHost,
): TaskNoticeDelivery {
  let reminded = false;
  pi.on("before_agent_start", (event) => {
    if (event.messageType === "user") reminded = false;
  });
  const continueForNotice = (
    event: AgentBeforeSettleEvent,
  ): AgentBeforeSettleEventResult | undefined =>
    hasUnansweredNotice(event.context, NOTICE_TYPES)
      ? { entries: event.entries, continue: true }
      : undefined;
  pi.on("agent_before_settle", (event): AgentBeforeSettleEventResult | undefined => {
    if (event.outcome !== "completed") return undefined;
    if (reminded) return continueForNotice(event);
    // A task already stopping needs nothing more from the subagent.
    const running = Arr.filter(host.activeTasks(), (task) => task.state !== "stopping");
    if (running.length === 0) return continueForNotice(event);
    reminded = true;
    return { entries: [...event.entries, runEndReminder(running)], continue: true };
  });
  return (notice, isCurrent) => {
    invokeHostCallback(() => {
      if (!isCurrent()) return;
      // Pi holds a busy session's notice until its turn ends, outside the steering queue.
      pi.sendMessage(
        { ...taskNoticeMessage(notice), display: true },
        { deliverAs: "steer", triggerTurn: false },
      );
    }, undefined);
  };
}
