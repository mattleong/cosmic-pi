import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { describe, expect, vi } from "vitest";
import { it } from "@effect/vitest";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import { extensionContextFixture } from "pi-cosmic-core/testing";
import { makeAskUserPromptGate } from "../src/boundary/host-prompt.ts";
import { makeAskUserDialogBridge } from "../src/boundary/host-ui.ts";

const context = (setStatus: (key: string, value: string | undefined) => void) =>
  extensionContextFixture({ mode: "tui", ui: { setStatus } });

setFlagsFromString("--expose-gc");
const gc: () => void = runInNewContext("gc");

// The gate outlives sessions, so every waiter it retained would pin its old session's fiber.
it.live("forgets each waiter once the gate reopens", () =>
  Effect.gen(function* () {
    const gate = makeAskUserPromptGate();
    // Each waiter lives only in this generator, so nothing else retains it once it returns.
    const waitOnce = Effect.gen(function* () {
      const release = gate.enter();
      const waiter = yield* Effect.forkChild(gate.awaitOpen, { startImmediately: true });
      release();
      yield* Fiber.join(waiter);
      return new WeakRef(waiter);
    });
    const references = yield* Effect.replicateEffect(waitOnce, 5);
    // WeakRef targets stay alive until the current job ends.
    yield* Effect.sleep("1 millis");
    gc();
    expect(references.filter((reference) => reference.deref() !== undefined)).toEqual([]);
  }),
);

it.effect(
  "queued mount waits for coalesced unrelated prompts, not just the owned overlay cleanup",
  () =>
    Effect.gen(function* () {
      const gate = makeAskUserPromptGate();
      const release = gate.enter();
      gate.started();
      expect(gate.canQueue()).toBe(true);
      let mounted = false;
      const waiting = yield* Effect.forkChild(
        gate.awaitOpen.pipe(
          Effect.andThen(
            Effect.sync(() => {
              mounted = true;
            }),
          ),
        ),
      );
      // A foreign nested prompt produces no second start event in Pi.
      release();
      yield* Effect.yieldNow;
      expect(mounted).toBe(false);
      expect(gate.canQueue()).toBe(false);
      expect(gate.canOpen()).toBe(false);
      gate.ended();
      yield* Fiber.join(waiting);
      expect(mounted).toBe(true);
    }),
);

describe("ask-user dialog bridge", () => {
  it("resumes the active dialog and ignores stale cleanup", () => {
    const statuses: Array<string | undefined> = [];
    const bridge = makeAskUserDialogBridge();
    bridge.setContext(context((_key, value) => statuses.push(value)));
    const first = bridge.activate(vi.fn());
    const resume = vi.fn();
    const second = bridge.activate(resume);

    bridge.clear(first);
    bridge.markCollapsed(second);
    expect(statuses.at(-1)).toContain("/ask-user");
    expect(bridge.resume()).toBe(true);
    expect(resume).toHaveBeenCalledOnce();
    expect(statuses.at(-1)).toBeUndefined();
  });

  it("clears status idempotently and reports no inactive resume", () => {
    const setStatus = vi.fn();
    const bridge = makeAskUserDialogBridge();
    bridge.setContext(context(setStatus));
    const token = bridge.activate(vi.fn());
    bridge.clear(token);
    bridge.clear(token);
    expect(bridge.resume()).toBe(false);
    expect(setStatus).toHaveBeenLastCalledWith("pi-ask-user", undefined);
  });
});
