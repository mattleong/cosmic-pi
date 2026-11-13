import type {
  AgentBeforeSettleEvent,
  BoundaryContextPreview,
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  SessionBoundaryDraft,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { vi } from "vitest";
import { registerSessionWake, type SessionWakeOptions } from "../src/host-wake.ts";
import { extensionContextFixture } from "../src/testing/host.ts";
import {
  agentBeforeSettleEventFixture,
  type DefaultedEventName,
  type ExtensionEventName,
  type ExtensionEventNamed,
} from "../src/testing/extension-events.ts";
import { recordingExtensionHost } from "../src/testing/extension-host.ts";
import { step } from "../src/testing/steps.ts";

type ContextMessage = BoundaryContextPreview["contextMessages"][number];

const NOTICE_TYPE = "test-notice";
const WAKE_TYPE = "test-wake";

const notice = (customType = NOTICE_TYPE): ContextMessage => ({
  role: "custom",
  customType,
  content: "A notice.",
  display: true,
  timestamp: 0,
});

const reply = (): ContextMessage => fauxAssistantMessage("Noted.");

const earlierEntry: SessionBoundaryDraft = {
  type: "custom_message",
  customType: "earlier-handler",
  content: "Added by an earlier handler.",
  display: false,
};

const settleEvent = (
  contextMessages: ReadonlyArray<ContextMessage>,
  pendingMessages: ReadonlyArray<ContextMessage> = [],
  outcome: AgentBeforeSettleEvent["outcome"] = "completed",
): AgentBeforeSettleEvent =>
  agentBeforeSettleEventFixture({
    contextMessages,
    pendingMessages,
    outcome,
    entries: [earlierEntry],
  });

const inputEvent = (source: InputEvent["source"]): InputEvent => ({
  type: "input",
  text: "next",
  source,
});

const dialog = { reason: "ui_prompt", kind: "confirm" } as const;

/** The recording host's `emit`, bound to the harness's context and returned as an Effect. */
interface ContextEmit {
  <Name extends DefaultedEventName>(
    name: Name,
    event?: ExtensionEventNamed<Name>,
  ): Effect.Effect<void>;
  <Name extends ExtensionEventName>(
    name: Name,
    event: ExtensionEventNamed<Name>,
  ): Effect.Effect<void>;
}
type UncheckedEmit<Name extends ExtensionEventName> = (
  name: Name,
  ctx: ExtensionContext,
  event?: ExtensionEventNamed<Name>,
) => Promise<void>;

const harness = (options: Partial<SessionWakeOptions> = {}) => {
  let idle = true;
  const checks: Array<() => void> = [];
  const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
  const host = recordingExtensionHost({}, { sendMessage });
  const onInterrupt = vi.fn();
  const wake = registerSessionWake(host.pi, {
    noticeTypes: new Set([NOTICE_TYPE]),
    wakeMessage: { customType: WAKE_TYPE, content: "Act on the notices above." },
    isIdle: () => idle,
    later: (check) => checks.push(check),
    onInterrupt,
    ...options,
  });
  const ctx = extensionContextFixture({});
  // Records whether each delivered notice was told to start a turn.
  const turns: Array<boolean> = [];
  const deliver = () =>
    wake.deliver((startTurn) => {
      turns.push(startTurn);
      return true;
    });
  const emit: ContextEmit = <Name extends ExtensionEventName>(
    name: Name,
    event?: ExtensionEventNamed<Name>,
  ) => step(() => (host.emit as UncheckedEmit<Name>)(name, ctx, event));
  const settle = (event: AgentBeforeSettleEvent) => {
    const [handler] = host.handlers.get("agent_before_settle");
    return Effect.promise(() => Promise.resolve(handler?.(event, ctx)));
  };
  const wakes = () =>
    Arr.filter(sendMessage.mock.calls, ([message]) => message.customType === WAKE_TYPE);
  return {
    ...host,
    sendMessage,
    wake,
    turns,
    deliver,
    emit,
    settle,
    wakes,
    onInterrupt,
    setIdle: (next: boolean) => {
      idle = next;
    },
    runChecks: () => {
      for (const check of checks.splice(0)) check();
    },
  };
};

/** A second wake owner on the same session, with its own idle state and deferred checks. */
const secondOwner = (test: ReturnType<typeof harness>, startsIdle: boolean) => {
  let idle = startsIdle;
  const checks: Array<() => void> = [];
  const other = registerSessionWake(test.pi, {
    noticeTypes: new Set(["other-notice"]),
    wakeMessage: { customType: "other-wake", content: "Act on the other notices." },
    isIdle: () => idle,
    later: (check) => checks.push(check),
  });
  return {
    other,
    otherWakes: () =>
      Arr.filter(test.sendMessage.mock.calls, ([message]) => message.customType === "other-wake"),
    runOtherChecks: () => {
      for (const check of checks.splice(0)) check();
    },
    setOtherIdle: (next: boolean) => {
      idle = next;
    },
  };
};

describe("session wake", () => {
  it.effect("starts a turn for a notice that arrives while the session is idle", () =>
    Effect.gen(function* () {
      const test = harness();
      expect(test.deliver()).toBe("woken");
      expect(test.turns).toEqual([true]);

      expect(yield* test.settle(settleEvent([notice(), reply()]))).toBeUndefined();
      yield* test.emit("agent_settled");
      expect(test.wakes()).toHaveLength(0);
    }),
  );

  it.effect("appends to a busy session and continues its run until the model replies", () =>
    Effect.gen(function* () {
      const test = harness();
      test.setIdle(false);
      expect(test.deliver()).toBe("queued");
      expect(test.turns).toEqual([false]);

      const pending = yield* test.settle(settleEvent([reply()], [notice()]));
      expect(pending).toEqual({ entries: [earlierEntry], continue: true });
      const appended = yield* test.settle(settleEvent([reply(), notice()]));
      expect(appended).toMatchObject({ continue: true });
      expect(yield* test.settle(settleEvent([notice(), reply()]))).toBeUndefined();

      yield* test.emit("agent_settled");
      expect(test.wakes()).toHaveLength(0);
    }),
  );

  it.effect("wakes once for a notice appended after the run's last settle boundary", () =>
    Effect.gen(function* () {
      const test = harness();
      test.setIdle(false);
      yield* test.settle(settleEvent([reply()]));
      test.deliver();

      yield* test.emit("agent_settled");
      yield* test.emit("agent_settled");
      expect(test.wakes()).toHaveLength(1);
      expect(test.wakes()[0]?.[1]).toMatchObject({ triggerTurn: true });
    }),
  );

  it.effect("holds wakes after the user interrupts, until the user's next prompt", () =>
    Effect.gen(function* () {
      const test = harness();
      yield* test.emit("agent_settled", { type: "agent_settled", aborted: true });
      expect(test.onInterrupt).toHaveBeenCalledOnce();
      expect(test.deliver()).toBe("held");
      expect(yield* test.settle(settleEvent([reply()], [notice()]))).toBeUndefined();
      yield* test.emit("agent_settled");

      yield* test.emit("input", inputEvent("extension"));
      test.deliver();
      yield* test.emit("input", inputEvent("interactive"));
      test.deliver();

      expect(test.turns).toEqual([false, false, true]);
      expect(test.wakes()).toHaveLength(0);
    }),
  );

  it.effect("appends while a dialog is open and wakes once the dialog closes", () =>
    Effect.gen(function* () {
      const test = harness({ holdDuringDialogs: true });
      yield* test.emit("ui_prompt_start", { type: "ui_prompt_start", ...dialog });
      expect(test.deliver()).toBe("held");
      yield* test.emit("agent_settled");
      expect(test.turns).toEqual([false]);
      expect(test.wakes()).toHaveLength(0);

      yield* test.emit("ui_prompt_end", { type: "ui_prompt_end", ...dialog });
      expect(test.wakes()).toHaveLength(1);
    }),
  );

  it.effect("wakes once for each dialog that deferred a notice", () =>
    Effect.gen(function* () {
      const test = harness({ holdDuringDialogs: true });
      for (let cycle = 0; cycle < 3; cycle += 1) {
        yield* test.emit("ui_prompt_start", { type: "ui_prompt_start", ...dialog });
        expect(test.deliver()).toBe("held");
        yield* test.emit("ui_prompt_end", { type: "ui_prompt_end", ...dialog });
      }
      expect(test.wakes()).toHaveLength(3);
    }),
  );

  it.effect("reports a notice Pi refused without owing it a turn", () =>
    Effect.gen(function* () {
      const test = harness();
      test.setIdle(false);
      expect(test.wake.deliver(() => false)).toBe("refused");
      yield* test.emit("agent_settled");
      expect(test.wakes()).toHaveLength(0);
    }),
  );

  it.effect("does not hold for dialogs unless asked to", () =>
    Effect.gen(function* () {
      const test = harness();
      yield* test.emit("ui_prompt_start", { type: "ui_prompt_start", ...dialog });
      test.deliver();
      expect(test.turns).toEqual([true]);
    }),
  );

  it.effect.each([true, false])(
    "waits for a compaction that ended with aborted=%s and wakes once the session is idle",
    (aborted) =>
      Effect.gen(function* () {
        const test = harness();
        test.setIdle(false);
        test.deliver();
        yield* test.emit("session_compact_failed", {
          type: "session_compact_failed",
          reason: "manual",
          aborted,
          willRetry: false,
          fromExtension: false,
        });
        for (let check = 0; check < 200; check += 1) test.runChecks();
        expect(test.wakes()).toHaveLength(0);

        test.setIdle(true);
        test.runChecks();
        expect(test.wakes()).toHaveLength(1);
      }),
  );

  // The harness's owner settles first and starts a turn that shows both owners' notices.
  const twoOwners = () => {
    const test = harness();
    const second = secondOwner(test, false);
    test.setIdle(false);
    test.deliver();
    second.other.deliver(() => true);
    return { test, ...second };
  };

  it.effect(
    "leaves a notice owed at settle to another owner's turn, waking if it never starts",
    () =>
      Effect.gen(function* () {
        const { test, otherWakes, runOtherChecks, setOtherIdle } = twoOwners();
        yield* test.emit("agent_settled");
        expect(test.wakes()).toHaveLength(1);
        expect(otherWakes()).toHaveLength(0);

        setOtherIdle(true);
        runOtherChecks();
        expect(otherWakes()).toHaveLength(1);
      }),
  );

  it("appends a notice to another owner's coming turn, waking if that turn fails", () => {
    const test = harness();
    const { other, otherWakes, runOtherChecks, setOtherIdle } = secondOwner(test, true);
    const turns: Array<boolean> = [];
    const deliverOther = () =>
      other.deliver((startTurn) => {
        turns.push(startTurn);
        return true;
      });

    // Pi still emits agent_settled, so the turn this owner started has not begun.
    expect(test.deliver()).toBe("woken");
    expect(deliverOther()).toBe("queued");
    expect(turns).toEqual([false]);
    setOtherIdle(false);
    runOtherChecks();
    expect(otherWakes()).toHaveLength(0);

    // That turn failed before it began, leaving the session idle.
    setOtherIdle(true);
    runOtherChecks();
    expect(otherWakes()).toHaveLength(1);
    expect(deliverOther()).toBe("woken");
    expect(turns).toEqual([false, true]);
  });

  it.effect("lets the turn another owner started at settle answer its notice", () =>
    Effect.gen(function* () {
      const { test, otherWakes, runOtherChecks, setOtherIdle } = twoOwners();
      yield* test.emit("agent_settled");
      runOtherChecks();
      yield* test.emit("agent_start");
      runOtherChecks();
      yield* test.emit(
        "agent_before_settle",
        settleEvent([notice(), notice("other-notice"), reply()]),
      );
      yield* test.emit("agent_settled");
      setOtherIdle(true);
      runOtherChecks();
      expect(test.wakes()).toHaveLength(1);
      expect(otherWakes()).toHaveLength(0);
    }),
  );

  it.effect("treats a run as busy until this owner's settle handler runs", () =>
    Effect.gen(function* () {
      const test = harness();
      yield* test.emit("agent_start");
      expect(test.deliver()).toBe("queued");
      yield* test.emit("agent_settled", { type: "agent_settled", aborted: true });
      expect(test.turns).toEqual([false]);
      expect(test.wakes()).toHaveLength(0);
    }),
  );

  for (const event of [
    { type: "session_before_switch", reason: "new" },
    { type: "session_before_fork", entryId: "entry", position: "before" },
    { type: "session_shutdown", reason: "new" },
  ] as const) {
    it.effect(`holds wakes from ${event.type} until the user's next prompt`, () =>
      Effect.gen(function* () {
        const test = harness();
        test.setIdle(false);
        test.deliver();
        yield* test.emit(event.type, event);
        expect(test.wake.closing()).toBe(true);
        yield* test.emit("agent_settled");
        test.setIdle(true);
        expect(test.deliver()).toBe("closing");
        yield* test.emit("agent_settled");
        expect(test.wakes()).toHaveLength(0);

        // Pi reports no cancelled or failed switch; the session is still open when its user prompts again.
        yield* test.emit("input", inputEvent("interactive"));
        expect(test.wake.closing()).toBe(false);
        expect(test.deliver()).toBe("woken");
        expect(test.turns).toEqual([false, false, true]);
      }),
    );
  }

  it.effect("lets the owner decide the settle boundary with the landed notice", () =>
    Effect.gen(function* () {
      const beforeSettle = vi.fn<NonNullable<SessionWakeOptions["beforeSettle"]>>(() => undefined);
      const test = harness({ beforeSettle });
      test.setIdle(false);
      test.deliver();
      yield* test.settle(settleEvent([reply()], [], "aborted"));
      expect(beforeSettle).not.toHaveBeenCalled();

      yield* test.settle(settleEvent([reply()], [notice()]));
      const [, , settle] = beforeSettle.mock.calls[0] ?? [];
      expect(settle?.landed).toBe(true);
      expect(settle?.takeOwed()).toBe(false);
      test.deliver();
      expect(settle?.takeOwed()).toBe(true);
      expect(settle?.takeOwed()).toBe(false);
    }),
  );

  it.effect("keeps a notice owed while a dialog is open as the run settles", () =>
    Effect.gen(function* () {
      const test = harness({ holdDuringDialogs: true });
      test.setIdle(false);
      expect(test.deliver()).toBe("queued");
      yield* test.emit("ui_prompt_start", { type: "ui_prompt_start", ...dialog });

      expect(yield* test.settle(settleEvent([reply()], [notice()]))).toBeUndefined();
      yield* test.emit("agent_settled");
      expect(test.wakes()).toHaveLength(0);

      test.setIdle(true);
      yield* test.emit("ui_prompt_end", { type: "ui_prompt_end", ...dialog });
      expect(test.wakes()).toHaveLength(1);
    }),
  );
});
