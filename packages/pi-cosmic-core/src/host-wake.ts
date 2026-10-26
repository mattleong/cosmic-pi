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

// Every owner in a session hears on Pi's shared event bus when another starts a turn.
const TURN_CHANNEL = "pi-cosmic-core:session-wake-turn";

/** What the wake owner knows at a completed run's settle boundary. */
export interface SessionWakeSettle {
  /** A notice arrived after the model's latest reply and wakes are not held or deferred by a dialog. */
  readonly landed: boolean;
  /** Whether wakes are held after an interrupt or while the session closes. */
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
 * held after an interrupt, during a dialog, or while the session closes; `refused` was not accepted
 * by Pi.
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
  /**
   * Whether the session is being replaced or shut down: from `session_before_switch`,
   * `session_before_fork`, `session_shutdown`, or `hold`, until the user's next prompt or a new
   * session. Pi reports no cancelled or failed switch or fork, so one keeps this until the user
   * prompts again.
   */
  readonly closing: () => boolean;
}

/**
 * Owns when notices may wake a Pi session. A notice starts a turn only while the session is idle.
 * While it is busy Pi appends the notice at the end of the current turn, outside the steering queue
 * that Esc, dequeue, and tree navigation clear, and this owner continues the settling run so the
 * model sees it. A user interrupt holds wakes until the user's next prompt; notices still append.
 * Wakes are also held while the session is being replaced or shut down. Every extension that
 * registers one gets its own handlers; Pi chains their settle results, and the owners at one settle
 * start at most one turn between them.
 */
export function registerSessionWake(pi: ExtensionAPI, options: SessionWakeOptions): SessionWake {
  // Wakes wait for the user's next prompt after an interrupt.
  let held = false;
  // The session is being replaced or shut down; wakes wait for a new session or the user's prompt.
  let closing = false;
  let dialogs = 0;
  // A notice was appended without a turn since the last turn began or settle boundary showed it.
  let owed = false;
  // From a run's start until this owner's agent_settled handler. Pi marks the session idle before
  // it awaits each extension's handler, and a turn started then would follow an interrupt.
  let running = false;
  // Another owner started a turn that has not begun yet, which shows the model this owner's notices.
  let turnComing = false;
  const self = Symbol("session-wake");
  const holding = (): boolean => held || closing;
  const blocked = (): boolean => holding() || dialogs > 0;

  // Pi defers a turn started while it emits agent_settled and runs each deferred turn in full, so
  // the other owners at that settle leave their notices to this one.
  const announceTurn = (): void => {
    invokeHostCallback(() => pi.events.emit(TURN_CHANNEL, self), undefined);
  };
  pi.events.on(TURN_CHANNEL, (sender) => {
    if (sender !== self) turnComing = true;
  });

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
    announceTurn();
  };
  // Polls while the session is busy without a run, as during a compaction or a run's start, or while
  // another owner's turn has not begun; a run that begins meanwhile continues for the notice or wakes
  // for it as it settles. An idle session means that turn failed before it began, as Pi then emits
  // neither agent_start nor agent_settled.
  const wakeWhenIdle = (): void => {
    if (!owed || blocked() || running) return;
    if (!invokeHostCallback(options.isIdle, false)) {
      options.later(wakeWhenIdle);
      return;
    }
    turnComing = false;
    wake();
  };
  const close = (): void => {
    closing = true;
    owed = false;
  };

  pi.on("agent_start", () => {
    running = true;
    turnComing = false;
  });

  pi.on("agent_settled", (event, ctx) => {
    running = false;
    const coming = turnComing;
    turnComing = false;
    if (event.aborted) {
      held = true;
      owed = false;
      options.onInterrupt?.(ctx);
      return;
    }
    // A notice that arrived after the last settle boundary still needs a turn. Another owner's turn
    // at this settle shows it to the model; wake once idle in case that turn never starts.
    if (!owed || blocked()) return;
    if (coming) options.later(wakeWhenIdle);
    else wake();
  });

  pi.on("input", (event) => {
    if (event.source === "extension") return;
    held = false;
    closing = false;
  });

  pi.on("session_start", () => {
    held = false;
    closing = false;
    dialogs = 0;
    owed = false;
    running = false;
    turnComing = false;
  });

  // Pi aborts the run and then emits session_shutdown to extensions in load order, so an earlier
  // extension's slow handler would otherwise leave this session idle and able to wake.
  pi.on("session_before_switch", close);
  pi.on("session_before_fork", close);
  pi.on("session_shutdown", close);
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
    if (!unanswered || holding()) owed = false;
    // An open dialog defers the turn; the notice stays owed until it closes.
    else if (dialogs > 0) owed = true;
    else {
      landed = true;
      owed = false;
    }
    const settle: SessionWakeSettle = {
      landed,
      held: holding,
      takeOwed: () => {
        if (holding()) owed = false;
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
        // A dialog defers the turn until it closes; a hold leaves the notice for the next prompt.
        if (!holding()) owed = true;
        return "held";
      }
      // Another owner's turn, still deferred while Pi emits agent_settled, will show this notice.
      const coming = !running && turnComing;
      const idle = !running && !coming && invokeHostCallback(options.isIdle, false);
      if (!send(idle)) return "refused";
      // A started turn shows the model every notice appended before it.
      owed = !idle;
      if (coming) options.later(wakeWhenIdle);
      if (!idle) return "queued";
      announceTurn();
      return "woken";
    },
    hold: close,
    closing: () => closing,
  };
}
