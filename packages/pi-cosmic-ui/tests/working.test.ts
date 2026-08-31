import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as MutableRef from "effect/MutableRef";
import * as TestClock from "effect/testing/TestClock";
import { provideBuiltLayer } from "pi-cosmic-core";
import { makeHostCallbackBoundary } from "../src/boundary/host-callback.ts";
import {
  makeWorkingMessageHost,
  type WorkingMessageHostContract,
  type WorkingMessageHostResult,
} from "../src/boundary/host-working-message.ts";
import { WorkingTimerService } from "../src/working/service.ts";
import { extensionContextFixture } from "./support/host.ts";

function workingHarness(
  set: (message?: string) => Effect.Effect<WorkingMessageHostResult> = () =>
    Effect.succeed("written"),
) {
  const messages: Array<string | undefined> = [];
  const delivered: Array<string | undefined> = [];
  const host: WorkingMessageHostContract = {
    set: (message) =>
      Effect.sync(() => {
        messages.push(message);
      }).pipe(
        Effect.andThen(set(message)),
        Effect.tap((result) =>
          Effect.sync(() => {
            if (result === "written") delivered.push(message);
          }),
        ),
      ),
  };
  const layer = WorkingTimerService.layer(host);
  return { messages, delivered, provide: provideBuiltLayer(layer) };
}

describe("Working message host", () => {
  it.effect("builds a contained live-context boundary", () => {
    const messages: Array<string | undefined> = [];
    const callbacks = makeHostCallbackBoundary();
    const context = MutableRef.make<ExtensionContext>(
      extensionContextFixture({
        mode: "tui" as const,
        ui: { setWorkingMessage: (message?: string) => void messages.push(message) },
      }),
    );
    const host = makeWorkingMessageHost({ context, callbacks });

    return Effect.gen(function* () {
      expect(yield* host.set("Working")).toBe("written");
      expect(messages).toEqual(["Working"]);

      MutableRef.set(context, extensionContextFixture({ mode: "rpc" as const }));
      expect(yield* host.set("Hidden")).toBe("unavailable");
      expect(messages).toEqual(["Working"]);

      MutableRef.set(
        context,
        extensionContextFixture({
          mode: "tui" as const,
          ui: {
            setWorkingMessage() {
              throw new Error("secret host failure");
            },
          },
        }),
      );
      expect(yield* host.set("Contained")).toBe("failed");
      expect(callbacks.diagnostics()).toEqual([{ operation: "working-message" }]);
    });
  });
});

describe("WorkingTimerService", () => {
  it.effect("retries after the initial TUI write throws", () => {
    let failFirst = true;
    const attempted: Array<string | undefined> = [];
    const delivered: Array<string | undefined> = [];
    const callbacks = makeHostCallbackBoundary();
    const context = MutableRef.make<ExtensionContext>(
      extensionContextFixture({
        mode: "tui" as const,
        ui: {
          setWorkingMessage(message?: string) {
            attempted.push(message);
            if (failFirst) {
              failFirst = false;
              throw new Error("transient host failure");
            }
            delivered.push(message);
          },
        },
      }),
    );
    const layer = WorkingTimerService.layer(makeWorkingMessageHost({ context, callbacks }));

    return Effect.gen(function* () {
      const timer = yield* WorkingTimerService;
      yield* timer.start;
      expect(attempted).toHaveLength(1);
      expect(delivered).toHaveLength(0);

      yield* TestClock.adjust("1 second");
      expect(attempted).toHaveLength(2);
      expect(delivered.at(-1)).toBe("Working · 1s");
    }).pipe(provideBuiltLayer(layer));
  });

  it.effect("does not tick when the working-message host is unavailable", () => {
    const harness = workingHarness(() => Effect.succeed("unavailable"));
    return Effect.gen(function* () {
      const timer = yield* WorkingTimerService;
      yield* timer.start;
      expect(harness.messages).toHaveLength(1);

      yield* TestClock.adjust("5 seconds");
      expect(harness.messages).toHaveLength(1);
    }).pipe(harness.provide);
  });

  it.effect("excludes an idempotent user-prompt span from elapsed work", () => {
    const harness = workingHarness();
    return Effect.gen(function* () {
      const timer = yield* WorkingTimerService;
      yield* timer.start;
      yield* TestClock.adjust("3 seconds");

      yield* timer.waitForUser;
      yield* timer.waitForUser;
      expect(harness.messages.at(-1)).toBe("Waiting for user");

      yield* TestClock.adjust("8 seconds");
      expect(harness.messages.at(-1)).toBe("Waiting for user");

      yield* timer.resumeFromUser;
      yield* timer.resumeFromUser;
      expect(harness.messages.at(-1)).toBe("Working · 3s");

      yield* TestClock.adjust("2 seconds");
      expect(harness.messages.at(-1)).toBe("Working · 5s");
    }).pipe(harness.provide);
  });

  it.effect("drops output admitted while waiting and excludes the wait from throughput", () => {
    const harness = workingHarness();
    return Effect.gen(function* () {
      const timer = yield* WorkingTimerService;
      yield* timer.start;
      timer.noteOutputCharacters(40);
      yield* TestClock.adjust("2 seconds");
      expect(harness.messages.at(-1)).toBe("Working · 2s · ~5.0 tok/s");

      yield* timer.waitForUser;
      timer.noteOutputCharacters(400);
      yield* TestClock.adjust("8 seconds");
      yield* timer.resumeFromUser;
      expect(harness.messages.at(-1)).toBe("Working · 2s · ~5.0 tok/s");

      timer.noteOutputCharacters(40);
      yield* TestClock.adjust("2 seconds");
      expect(harness.messages.at(-1)).toBe("Working · 4s · ~5.0 tok/s");
    }).pipe(harness.provide);
  });

  it.effect("preserves a prompt wait admitted before timer startup", () => {
    const harness = workingHarness();
    return Effect.gen(function* () {
      const timer = yield* WorkingTimerService;
      yield* timer.waitForUser;
      yield* timer.start;

      yield* TestClock.adjust("8 seconds");
      expect(harness.messages.at(-1)).toBe("Waiting for user");

      yield* timer.resumeFromUser;
      expect(harness.messages.at(-1)).toBe("Working · 0s");
      yield* TestClock.adjust("1 second");
      expect(harness.messages.at(-1)).toBe("Working · 1s");
    }).pipe(harness.provide);
  });

  it.effect("keeps prompt timing active when transient host writes defect", () => {
    let failNext = false;
    const harness = workingHarness(() => {
      if (!failNext) return Effect.succeed("written" as const);
      failNext = false;
      return Effect.die(new Error("host write failed"));
    });
    return Effect.gen(function* () {
      const timer = yield* WorkingTimerService;
      yield* timer.start;
      yield* TestClock.adjust("2 seconds");

      failNext = true;
      yield* timer.waitForUser;
      const writesAfterFailedWait = harness.messages.length;
      yield* TestClock.adjust("8 seconds");
      expect(harness.messages.length).toBeGreaterThan(writesAfterFailedWait);
      expect(harness.delivered.at(-1)).toBe("Waiting for user");
      failNext = true;
      yield* timer.resumeFromUser;
      yield* TestClock.adjust("1 second");

      expect(harness.messages.at(-1)).toBe("Working · 3s");
      yield* timer.stop;
    }).pipe(harness.provide);
  });

  it.effect("retries after a transient ticker write defect", () => {
    let failNext = false;
    const harness = workingHarness(() => {
      if (!failNext) return Effect.succeed("written" as const);
      failNext = false;
      return Effect.die(new Error("host write failed"));
    });
    return Effect.gen(function* () {
      const timer = yield* WorkingTimerService;
      yield* timer.start;
      failNext = true;
      yield* TestClock.adjust("1 second");
      const writesAfterFailure = harness.messages.length;

      yield* TestClock.adjust("1 second");
      expect(harness.messages.length).toBe(writesAfterFailure + 1);
      expect(harness.delivered.at(-1)).toBe("Working · 2s");
    }).pipe(harness.provide);
  });
});
