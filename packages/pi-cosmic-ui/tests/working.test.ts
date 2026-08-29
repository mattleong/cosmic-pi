import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { provideBuiltLayer } from "pi-cosmic-core";
import { WorkingMessageHost } from "../src/boundary/host-working-message.ts";
import { WorkingTimerService } from "../src/working/service.ts";

function workingHarness(
  set: (message?: string) => Effect.Effect<boolean> = () => Effect.succeed(true),
) {
  const messages: Array<string | undefined> = [];
  const delivered: Array<string | undefined> = [];
  const host = Layer.succeed(
    WorkingMessageHost,
    WorkingMessageHost.of({
      set: (message) =>
        Effect.sync(() => {
          messages.push(message);
        }).pipe(
          Effect.andThen(set(message)),
          Effect.tap((available) =>
            Effect.sync(() => {
              if (available) delivered.push(message);
            }),
          ),
        ),
    }),
  );
  const layer = WorkingTimerService.layer.pipe(Layer.provide(host));
  return { messages, delivered, provide: provideBuiltLayer(layer) };
}

describe("WorkingTimerService", () => {
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
      if (!failNext) return Effect.succeed(true);
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
      if (!failNext) return Effect.succeed(true);
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
