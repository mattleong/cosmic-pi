import type {
  AgentBeforeSettleEvent,
  AgentBeforeSettleEventResult,
  BoundaryContextPreview,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { invokeHostCallback } from "./host-session.ts";

type ContextMessage = BoundaryContextPreview["contextMessages"][number];

const isNoticeOf =
  (customTypes: ReadonlySet<string>) =>
  (message: ContextMessage): boolean =>
    message.role === "custom" && customTypes.has(message.customType);

/**
 * Whether a notice of one of `customTypes` arrived after the model's latest reply: either in the
 * context after the last assistant message, or held by Pi to be appended at this boundary. Such a
 * notice was appended without starting a turn, so the settling run has to continue for the model to
 * see it.
 */
export const hasUnansweredNotice = (
  context: BoundaryContextPreview,
  customTypes: ReadonlySet<string>,
): boolean => {
  const isNotice = isNoticeOf(customTypes);
  if (Arr.some(context.pendingMessages, isNotice)) return true;
  const messages = context.contextMessages;
  const lastReply = Arr.findLastIndex(messages, (message) => message.role === "assistant");
  return Arr.some(
    messages.slice(Option.match(lastReply, { onNone: () => 0, onSome: (index) => index + 1 })),
    isNotice,
  );
};

// After a compaction the session becomes idle once the host finishes its own handlers.
const IDLE_CHECK_LIMIT = 40;

/** What the wake owner knows at a completed run's settle boundary. */
export interface SessionWakeSettle {
  /** A notice arrived after the model's latest reply and wakes are not held or deferred by a dialog. */
  readonly landed: boolean;
  /** Whether wakes are held after an interrupt or during shutdown. */
  readonly held: () => boolean;
  /**
   * Whether a notice was appended since this boundary began and still needs a turn; clears it. A
   * notice deferred by an open dialog stays owed until it closes.
   */
  readonly takeOwed: () => boolean;
}

export type SessionWakeSettleResult =
  | AgentBeforeSettleEventResult
  | Promise<AgentBeforeSettleEventResult | undefined>
  | undefined;

export interface SessionWakeOptions {
  /** Custom message types whose unanswered arrival continues a settling run. */
  readonly noticeTypes: ReadonlySet<string>;
  /** Hidden message that starts a turn for notices appended after the last settle boundary. */
  readonly wakeMessage: { readonly customType: string; readonly content: string };
  /** Whether the session has neither a run nor a compaction in progress. */
  readonly isIdle: () => boolean;
  /** Runs `check` again shortly, outside the current host callback. */
  readonly later: (check: () => void) => void;
  /** Also append without a turn while a blocking extension dialog is open; wake once it closes. */
  readonly holdDuringDialogs?: boolean;
  /** Called when the user interrupts a run, after wakes are held until their next prompt. */
  readonly onInterrupt?: (ctx: ExtensionContext) => void;
  /**
   * Decides a completed run's settle boundary instead of the default, which continues the run
   * exactly when a notice landed. Results must keep `event.entries`: Pi passes each handler the
   * entries and `continue` of earlier handlers and keeps the last defined value of each.
   */
  readonly beforeSettle?: (
    event: AgentBeforeSettleEvent,
    ctx: ExtensionContext,
    settle: SessionWakeSettle,
  ) => SessionWakeSettleResult;
}

/**
 * How a delivered notice reached the session: `woken` started a turn; `queued` was appended to a
 * busy session, whose settling run continues; `held` was appended without a turn while wakes are
 * held after an interrupt or during a dialog; `refused` was not accepted by Pi.
 */
export type SessionWakeDelivery = "woken" | "queued" | "held" | "refused";

export interface SessionWake {
  /**
   * Runs `send` once, telling it whether to start a turn, and reports how Pi took it. A notice
   * accepted without a turn is owed one: the settling run continues, or the session wakes.
   */
  readonly deliver: (send: (startTurn: boolean) => boolean) => SessionWakeDelivery;
  /** Holds wakes until the user's next prompt or a new session, as the session shuts down. */
  readonly hold: () => void;
}

/**
 * Owns when notices may wake a Pi session. A notice starts a turn only while the session is idle.
 * While it is busy Pi appends the notice at the end of the current turn, outside the steering queue
 * that Esc, dequeue, and tree navigation clear, and this owner continues the settling run so the
 * model sees it. A user interrupt holds wakes until the user's next prompt; notices still append.
 * Every extension that registers one gets its own handlers; Pi chains their settle results.
 */
export function registerSessionWake(pi: ExtensionAPI, options: SessionWakeOptions): SessionWake {
  let held = false;
  let dialogs = 0;
  // A notice was appended without a turn since the last turn began or settle boundary showed it.
  let owed = false;
  const blocked = (): boolean => held || dialogs > 0;

  const wake = (): void => {
    owed = false;
    invokeHostCallback(() => {
      pi.sendMessage(
        {
          customType: options.wakeMessage.customType,
          content: options.wakeMessage.content,
          display: false,
        },
        { triggerTurn: true },
      );
    }, undefined);
  };
  const wakeWhenIdle = (checks = 0): void => {
    if (!owed || blocked()) return;
    if (invokeHostCallback(options.isIdle, false)) {
      wake();
      return;
    }
    if (checks < IDLE_CHECK_LIMIT) options.later(() => wakeWhenIdle(checks + 1));
  };

  pi.on("agent_settled", (event, ctx) => {
    if (!event.aborted) {
      // A notice that arrived after the last settle boundary still needs a turn.
      if (owed && !blocked()) wake();
      return;
    }
    held = true;
    owed = false;
    options.onInterrupt?.(ctx);
  });

  pi.on("input", (event) => {
    if (event.source !== "extension") held = false;
  });

  pi.on("session_start", () => {
    held = false;
    dialogs = 0;
    owed = false;
  });

  // Notices owed a turn belong to the branch the user left.
  pi.on("session_tree", () => {
    owed = false;
  });

  // A manual compaction makes the session busy without a run; wake it once compaction ends.
  pi.on("session_compact", () => wakeWhenIdle());
  pi.on("session_compact_failed", () => wakeWhenIdle());

  if (options.holdDuringDialogs) {
    pi.on("ui_prompt_start", () => {
      dialogs += 1;
    });
    pi.on("ui_prompt_end", () => {
      dialogs = Math.max(0, dialogs - 1);
      wakeWhenIdle();
    });
  }

  pi.on("agent_before_settle", (event, ctx): SessionWakeSettleResult => {
    if (event.outcome !== "completed") return undefined;
    const unanswered = hasUnansweredNotice(event.context, options.noticeTypes);
    let landed = false;
    if (!unanswered || held) owed = false;
    // An open dialog defers the turn; the notice stays owed until it closes.
    else if (dialogs > 0) owed = true;
    else {
      landed = true;
      owed = false;
    }
    const settle: SessionWakeSettle = {
      landed,
      held: () => held,
      takeOwed: () => {
        if (held) owed = false;
        if (!owed || dialogs > 0) return false;
        owed = false;
        return true;
      },
    };
    if (options.beforeSettle) return options.beforeSettle(event, ctx, settle);
    return landed ? { entries: event.entries, continue: true } : undefined;
  });

  return {
    deliver: (send) => {
      if (blocked()) {
        if (!send(false)) return "refused";
        if (!held) owed = true;
        return "held";
      }
      const idle = invokeHostCallback(options.isIdle, false);
      if (!send(idle)) return "refused";
      // A started turn shows the model every notice appended before it.
      owed = !idle;
      return idle ? "woken" : "queued";
    },
    hold: () => {
      held = true;
    },
  };
}
