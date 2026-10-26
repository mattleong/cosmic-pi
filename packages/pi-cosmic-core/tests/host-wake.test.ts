import type {
  AgentBeforeSettleEvent,
  BoundaryContextPreview,
  ExtensionAPI,
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
import { recordingExtensionHost } from "../src/testing/extension-host.ts";

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
): AgentBeforeSettleEvent => ({
  type: "agent_before_settle",
  outcome,
  entries: [earlierEntry],
  continue: false,
  context: {
    contextEntries: [],
    contextMessages: [...contextMessages],
    llmMessages: [],
    pendingMessages: [...pendingMessages],
    canContinue: true,
  },
});

const inputEvent = (source: InputEvent["source"]): InputEvent => ({
  type: "input",
  text: "next",
  source,
});

const dialog = { reason: "ui_prompt", kind: "confirm" } as const;

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
  const settle = (event: AgentBeforeSettleEvent) => {
    const [handler] = host.handlers.get("agent_before_settle");
    return Promise.resolve(handler?.(event, ctx));
  };
  const wakes = () =>
    Arr.filter(sendMessage.mock.calls, ([message]) => message.customType === WAKE_TYPE);
  return {
    ...host,
    sendMessage,
    wake,
    ctx,
    turns,
    deliver,
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

describe("session wake", () => {
  it.effect("starts a turn for a notice that arrives while the session is idle", () =>
    Effect.gen(function* () {
      const test = harness();
      expect(test.deliver()).toBe("woken");
      expect(test.turns).toEqual([true]);

      expect(
        yield* Effect.promise(() => test.settle(settleEvent([notice(), reply()]))),
      ).toBeUndefined();
      yield* Effect.promise(() => test.emit("agent_settled", test.ctx));
      expect(test.wakes()).toHaveLength(0);
    }),
  );

  it.effect("appends to a busy session and continues its run until the model replies", () =>
    Effect.gen(function* () {
      const test = harness();
      test.setIdle(false);
      expect(test.deliver()).toBe("queued");
      expect(test.turns).toEqual([false]);

      const pending = yield* Effect.promise(() => test.settle(settleEvent([reply()], [notice()])));
      expect(pending).toEqual({ entries: [earlierEntry], continue: true });
      const appended = yield* Effect.promise(() => test.settle(settleEvent([reply(), notice()])));
      expect(appended).toMatchObject({ continue: true });
      expect(
        yield* Effect.promise(() => test.settle(settleEvent([notice(), reply()]))),
      ).toBeUndefined();

      yield* Effect.promise(() => test.emit("agent_settled", test.ctx));
      expect(test.wakes()).toHaveLength(0);
    }),
  );

  it.effect("wakes once for a notice appended after the run's last settle boundary", () =>
    Effect.gen(function* () {
      const test = harness();
      test.setIdle(false);
      yield* Effect.promise(() => test.settle(settleEvent([reply()])));
      test.deliver();

      yield* Effect.promise(() => test.emit("agent_settled", test.ctx));
      yield* Effect.promise(() => test.emit("agent_settled", test.ctx));
      expect(test.wakes()).toHaveLength(1);
      expect(test.wakes()[0]?.[1]).toMatchObject({ triggerTurn: true });
    }),
  );

  it.effect("holds wakes after the user interrupts, until the user's next prompt", () =>
    Effect.gen(function* () {
      const test = harness();
      yield* Effect.promise(() =>
        test.emit("agent_settled", test.ctx, { type: "agent_settled", aborted: true }),
      );
      expect(test.onInterrupt).toHaveBeenCalledOnce();
      expect(test.deliver()).toBe("held");
      expect(
        yield* Effect.promise(() => test.settle(settleEvent([reply()], [notice()]))),
      ).toBeUndefined();
      yield* Effect.promise(() => test.emit("agent_settled", test.ctx));

      yield* Effect.promise(() => test.emit("input", test.ctx, inputEvent("extension")));
      test.deliver();
      yield* Effect.promise(() => test.emit("input", test.ctx, inputEvent("interactive")));
      test.deliver();

      expect(test.turns).toEqual([false, false, true]);
      expect(test.wakes()).toHaveLength(0);
    }),
  );

  it.effect("appends while a dialog is open and wakes once the dialog closes", () =>
    Effect.gen(function* () {
      const test = harness({ holdDuringDialogs: true });
      yield* Effect.promise(() =>
        test.emit("ui_prompt_start", test.ctx, { type: "ui_prompt_start", ...dialog }),
      );
      expect(test.deliver()).toBe("held");
      yield* Effect.promise(() => test.emit("agent_settled", test.ctx));
      expect(test.turns).toEqual([false]);
      expect(test.wakes()).toHaveLength(0);

      yield* Effect.promise(() =>
        test.emit("ui_prompt_end", test.ctx, { type: "ui_prompt_end", ...dialog }),
      );
      expect(test.wakes()).toHaveLength(1);
    }),
  );

  it.effect("reports a notice Pi refused without owing it a turn", () =>
    Effect.gen(function* () {
      const test = harness();
      test.setIdle(false);
      expect(test.wake.deliver(() => false)).toBe("refused");
      yield* Effect.promise(() => test.emit("agent_settled", test.ctx));
      expect(test.wakes()).toHaveLength(0);
    }),
  );

  it.effect("does not hold for dialogs unless asked to", () =>
    Effect.gen(function* () {
      const test = harness();
      yield* Effect.promise(() =>
        test.emit("ui_prompt_start", test.ctx, { type: "ui_prompt_start", ...dialog }),
      );
      test.deliver();
      expect(test.turns).toEqual([true]);
    }),
  );

  it.effect("wakes after a compaction ends once the session becomes idle", () =>
    Effect.gen(function* () {
      const test = harness();
      test.setIdle(false);
      test.deliver();
      yield* Effect.promise(() =>
        test.emit("session_compact_failed", test.ctx, {
          type: "session_compact_failed",
          reason: "manual",
          aborted: true,
          willRetry: false,
          fromExtension: false,
        }),
      );
      expect(test.wakes()).toHaveLength(0);

      test.setIdle(true);
      test.runChecks();
      expect(test.wakes()).toHaveLength(1);
    }),
  );

  it.effect("keeps waiting for a long compaction to end before it wakes", () =>
    Effect.gen(function* () {
      const test = harness();
      test.setIdle(false);
      test.deliver();
      yield* Effect.promise(() =>
        test.emit("session_compact_failed", test.ctx, {
          type: "session_compact_failed",
          reason: "manual",
          aborted: false,
          willRetry: false,
          fromExtension: false,
        }),
      );
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
    let idle = false;
    const checks: Array<() => void> = [];
    const other = registerSessionWake(test.pi, {
      noticeTypes: new Set(["other-notice"]),
      wakeMessage: { customType: "other-wake", content: "Act on the other notices." },
      isIdle: () => idle,
      later: (check) => checks.push(check),
    });
    test.setIdle(false);
    test.deliver();
    other.deliver(() => true);
    const otherWakes = () =>
      Arr.filter(test.sendMessage.mock.calls, ([message]) => message.customType === "other-wake");
    const runOtherChecks = () => {
      for (const check of checks.splice(0)) check();
    };
    return {
      test,
      otherWakes,
      runOtherChecks,
      setOtherIdle: (next: boolean) => {
        idle = next;
      },
    };
  };

  it.effect(
    "leaves a notice owed at settle to another owner's turn, waking if it never starts",
    () =>
      Effect.gen(function* () {
        const { test, otherWakes, runOtherChecks, setOtherIdle } = twoOwners();
        yield* Effect.promise(() => test.emit("agent_settled", test.ctx));
        expect(test.wakes()).toHaveLength(1);
        expect(otherWakes()).toHaveLength(0);

        setOtherIdle(true);
        runOtherChecks();
        expect(otherWakes()).toHaveLength(1);
      }),
  );

  it.effect("appends a notice to another owner's coming turn, waking if that turn fails", () =>
    Effect.sync(() => {
      const test = harness();
      const turns: Array<boolean> = [];
      let otherIdle = true;
      const checks: Array<() => void> = [];
      const other = registerSessionWake(test.pi, {
        noticeTypes: new Set(["other-notice"]),
        wakeMessage: { customType: "other-wake", content: "Act on the other notices." },
        isIdle: () => otherIdle,
        later: (check) => checks.push(check),
      });
      const deliverOther = () =>
        other.deliver((startTurn) => {
          turns.push(startTurn);
          return true;
        });
      const otherWakes = () =>
        Arr.filter(test.sendMessage.mock.calls, ([message]) => message.customType === "other-wake");

      // Pi still emits agent_settled, so the turn this owner started has not begun.
      expect(test.deliver()).toBe("woken");
      expect(deliverOther()).toBe("queued");
      expect(turns).toEqual([false]);
      otherIdle = false;
      for (const check of checks.splice(0)) check();
      expect(otherWakes()).toHaveLength(0);

      // That turn failed before it began, leaving the session idle.
      otherIdle = true;
      for (const check of checks.splice(0)) check();
      expect(otherWakes()).toHaveLength(1);
      expect(deliverOther()).toBe("woken");
      expect(turns).toEqual([false, true]);
    }),
  );

  it.effect("lets the turn another owner started at settle answer its notice", () =>
    Effect.gen(function* () {
      const { test, otherWakes, runOtherChecks, setOtherIdle } = twoOwners();
      yield* Effect.promise(() => test.emit("agent_settled", test.ctx));
      runOtherChecks();
      yield* Effect.promise(() => test.emit("agent_start", test.ctx));
      runOtherChecks();
      yield* Effect.promise(() =>
        test.emit(
          "agent_before_settle",
          test.ctx,
          settleEvent([notice(), notice("other-notice"), reply()]),
        ),
      );
      yield* Effect.promise(() => test.emit("agent_settled", test.ctx));
      setOtherIdle(true);
      runOtherChecks();
      expect(test.wakes()).toHaveLength(1);
      expect(otherWakes()).toHaveLength(0);
    }),
  );

  it.effect("treats a run as busy until this owner's settle handler runs", () =>
    Effect.gen(function* () {
      const test = harness();
      yield* Effect.promise(() => test.emit("agent_start", test.ctx));
      expect(test.deliver()).toBe("queued");
      yield* Effect.promise(() =>
        test.emit("agent_settled", test.ctx, { type: "agent_settled", aborted: true }),
      );
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
        yield* Effect.promise(() => test.emit(event.type, test.ctx, event));
        expect(test.wake.closing()).toBe(true);
        yield* Effect.promise(() => test.emit("agent_settled", test.ctx));
        test.setIdle(true);
        expect(test.deliver()).toBe("held");
        yield* Effect.promise(() => test.emit("agent_settled", test.ctx));
        expect(test.wakes()).toHaveLength(0);

        // Pi reports no cancelled or failed switch; the session is still open when its user prompts again.
        yield* Effect.promise(() => test.emit("input", test.ctx, inputEvent("interactive")));
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
      yield* Effect.promise(() => test.settle(settleEvent([reply()], [], "aborted")));
      expect(beforeSettle).not.toHaveBeenCalled();

      yield* Effect.promise(() => test.settle(settleEvent([reply()], [notice()])));
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
      yield* Effect.promise(() =>
        test.emit("ui_prompt_start", test.ctx, { type: "ui_prompt_start", ...dialog }),
      );

      expect(
        yield* Effect.promise(() => test.settle(settleEvent([reply()], [notice()]))),
      ).toBeUndefined();
      yield* Effect.promise(() => test.emit("agent_settled", test.ctx));
      expect(test.wakes()).toHaveLength(0);

      test.setIdle(true);
      yield* Effect.promise(() =>
        test.emit("ui_prompt_end", test.ctx, { type: "ui_prompt_end", ...dialog }),
      );
      expect(test.wakes()).toHaveLength(1);
    }),
  );
});
