import type {
  AgentBeforeSettleEvent,
  AgentBeforeSettleEventResult,
  BoundaryContextPreview,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
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
  if (context.pendingMessages.some(isNotice)) return true;
  const messages = context.contextMessages;
  const lastReply = messages.findLastIndex((message) => message.role === "assistant");
  return messages.slice(lastReply + 1).some(isNotice);
};

// After a compaction the session becomes idle once the host finishes its own handlers.
const IDLE_CHECK_LIMIT = 40;

/** What the wake owner knows at a completed run's settle boundary. */
export interface SessionWakeSettle {
  /**
   * A notice arrived after the model's latest reply, wakes are not held or deferred by a dialog,
   * and its wake budget admitted the continuation.
   */
  readonly landed: boolean;
  /** Whether wakes are held after an interrupt or during shutdown. */
  readonly held: () => boolean;
  /**
   * Whether a notice was appended since this boundary began, still needs a turn, and its wake
   * budget admits one; clears it. A notice deferred by an open dialog stays owed until it closes.
   */
  readonly takeOwed: () => boolean;
}

export type SessionWakeSettleResult =
  | AgentBeforeSettleEventResult
  | Promise<AgentBeforeSettleEventResult | undefined>
  | undefined;

/**
 * Limits the turns a kind of notice may start or continue. The wake consults it before every
 * automatic turn it would start or continue for such a notice, including deferred wakes after a
 * dialog, a compaction, or a settle boundary, and spends one turn as that turn starts.
 */
export interface SessionWakeBudget {
  readonly available: () => boolean;
  readonly spend: () => void;
}

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
 * held after an interrupt, during a dialog, or because its wake budget was spent; `refused` was not
 * accepted by Pi.
 */
export type SessionWakeDelivery = "woken" | "queued" | "held" | "refused";

export interface SessionWake {
  /**
   * Runs `send` once, telling it whether to start a turn, and reports how Pi took it. A notice
   * accepted without a turn is owed one: the settling run continues, or the session wakes. With a
   * `budget`, every turn the notice would start or continue must be available from it; once it is
   * spent the notice only appends.
   */
  readonly deliver: (
    send: (startTurn: boolean) => boolean,
    budget?: SessionWakeBudget,
  ) => SessionWakeDelivery;
  /** Holds wakes until the user's next prompt or a new session, as the session shuts down. */
  readonly hold: () => void;
}

/**
 * A turn owed to notices appended without one: none, already admitted (unbudgeted or spent), or
 * awaiting admission from one of the budgets of the notices that wait for it.
 */
type OwedTurn =
  | { readonly kind: "none" }
  | { readonly kind: "admitted" }
  | { readonly kind: "pending"; readonly budgets: ReadonlySet<SessionWakeBudget> };

const NOT_OWED: OwedTurn = { kind: "none" };
const ADMITTED: OwedTurn = { kind: "admitted" };

const owe = (owed: OwedTurn, budget: SessionWakeBudget | undefined): OwedTurn => {
  if (owed.kind === "admitted" || budget === undefined) return ADMITTED;
  return {
    kind: "pending",
    budgets: new Set([...(owed.kind === "pending" ? owed.budgets : []), budget]),
  };
};

/**
 * Owns when notices may wake a Pi session. A notice starts a turn only while the session is idle.
 * While it is busy Pi appends the notice at the end of the current turn, outside the steering queue
 * that Esc, dequeue, and tree navigation clear, and this owner continues the settling run so the
 * model sees it. A user interrupt holds wakes until the user's next prompt; notices still append.
 * A notice's wake budget is charged once for each turn it starts or continues, and notices that join
 * an admitted continuation are free. Every extension that registers one gets its own handlers; Pi
 * chains their settle results.
 */
export function registerSessionWake(pi: ExtensionAPI, options: SessionWakeOptions): SessionWake {
  let held = false;
  let dialogs = 0;
  // Notices appended without a turn since the last turn began or settle boundary showed them.
  let owed: OwedTurn = NOT_OWED;
  // A budget refused a notice's turn, so unanswered notices no longer continue a run by themselves.
  let denied = false;
  const blocked = (): boolean => held || dialogs > 0;

  // Admits the owed turn, spending one budget's turn if no earlier admission covers it.
  const admitOwed = (): boolean => {
    if (owed.kind === "admitted") return true;
    if (owed.kind === "pending")
      for (const budget of owed.budgets)
        if (invokeHostCallback(budget.available, false)) {
          invokeHostCallback(budget.spend, undefined);
          owed = ADMITTED;
          return true;
        }
    if (owed.kind === "pending") denied = true;
    owed = NOT_OWED;
    return false;
  };

  const wake = (): void => {
    owed = NOT_OWED;
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
    if (owed.kind === "none" || blocked()) return;
    if (invokeHostCallback(options.isIdle, false)) {
      if (admitOwed()) wake();
      return;
    }
    if (checks < IDLE_CHECK_LIMIT) options.later(() => wakeWhenIdle(checks + 1));
  };

  pi.on("agent_settled", (event, ctx) => {
    if (!event.aborted) {
      // A notice that arrived after the last settle boundary still needs a turn.
      if (owed.kind !== "none" && !blocked() && admitOwed()) wake();
      return;
    }
    held = true;
    owed = NOT_OWED;
    options.onInterrupt?.(ctx);
  });

  pi.on("input", (event) => {
    if (event.source === "extension") return;
    held = false;
    denied = false;
  });

  pi.on("session_start", () => {
    held = false;
    dialogs = 0;
    owed = NOT_OWED;
    denied = false;
  });

  // Notices owed a turn belong to the branch the user left.
  pi.on("session_tree", () => {
    owed = NOT_OWED;
    denied = false;
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
    if (!unanswered) {
      owed = NOT_OWED;
      denied = false;
    }
    let landed = false;
    if (unanswered && held) owed = NOT_OWED;
    else if (unanswered && dialogs > 0) {
      // The dialog defers the turn; the notice stays owed until it closes.
      if (owed.kind === "none" && !denied) owed = ADMITTED;
    } else if (unanswered) {
      // Without an owed turn, a notice still unanswered after its own continuation continues
      // again, unless a spent budget appended it.
      landed = owed.kind === "none" ? !denied : admitOwed();
      owed = NOT_OWED;
    }
    const settle: SessionWakeSettle = {
      landed,
      held: () => held,
      takeOwed: () => {
        if (held) owed = NOT_OWED;
        if (owed.kind === "none" || dialogs > 0) return false;
        const admitted = admitOwed();
        owed = NOT_OWED;
        return admitted;
      },
    };
    if (options.beforeSettle) return options.beforeSettle(event, ctx, settle);
    return landed ? { entries: event.entries, continue: true } : undefined;
  });

  return {
    deliver: (send, budget) => {
      if (blocked()) {
        if (!send(false)) return "refused";
        if (!held) owed = owe(owed, budget);
        return "held";
      }
      const idle = invokeHostCallback(options.isIdle, false);
      // Joining an admitted continuation is free; anything else needs a turn from the budget.
      const admitted =
        budget === undefined ||
        (!idle && owed.kind === "admitted") ||
        invokeHostCallback(budget.available, false);
      if (!admitted) {
        if (!send(false)) return "refused";
        denied = true;
        return "held";
      }
      if (!send(idle)) return "refused";
      if (budget !== undefined && (idle || owed.kind !== "admitted"))
        invokeHostCallback(budget.spend, undefined);
      // A started turn shows the model every notice appended before it.
      owed = idle ? NOT_OWED : ADMITTED;
      return idle ? "woken" : "queued";
    },
    hold: () => {
      held = true;
    },
  };
}
