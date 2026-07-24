import { expect, it, layer } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { WorkingMessageHost } from "../src/boundary/host-working-message.ts";
import {
  estimateTokensPerSecond,
  formatWorkingElapsed,
  formatWorkingMessage,
  WorkingTimerService,
} from "../src/working/service.ts";

it("formats elapsed working time compactly", () => {
  expect(formatWorkingElapsed(0)).toBe("0s");
  expect(formatWorkingElapsed(59_999)).toBe("59s");
  expect(formatWorkingElapsed(60_000)).toBe("1m 00s");
  expect(formatWorkingElapsed(3_754_000)).toBe("1h 02m 34s");
  expect(estimateTokensPerSecond(400, 10_000)).toBe(10);
  expect(estimateTokensPerSecond(400, 999)).toBeUndefined();
  expect(formatWorkingMessage(134_000)).toBe("Working · 2m 14s");
  expect(formatWorkingMessage(10_000, 400)).toBe("Working · 10s · ~10.0 tok/s");
  expect(formatWorkingMessage(10_000, 400, 2_000)).toBe("Working · 10s · ~50.0 tok/s");
});

const messages: Array<string | undefined> = [];
const host = Layer.succeed(
  WorkingMessageHost,
  WorkingMessageHost.of({
    set: (message) =>
      Effect.sync(() => {
        messages.push(message);
        return true;
      }),
  }),
);
const timer = WorkingTimerService.layer.pipe(Layer.provide(host));

it.effect("clears the working row and stops ticking when its scope closes", () =>
  Effect.gen(function* () {
    messages.length = 0;
    const scope = yield* Scope.make();
    yield* Effect.gen(function* () {
      const context = yield* Layer.buildWithScope(timer, scope);
      const service = Context.get(context, WorkingTimerService);
      yield* service.start;
      yield* TestClock.adjust(2_000);
      expect(messages.at(-1)).toBe("Working · 2s");
    }).pipe(Effect.ensuring(Scope.close(scope, Exit.void)));

    expect(messages.at(-1)).toBeUndefined();
    const finalizedCount = messages.length;
    yield* TestClock.adjust(5_000);
    expect(messages).toHaveLength(finalizedCount);
  }),
);

it.effect("does not install a ticker when startup is interrupted", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const observed: Array<string | undefined> = [];
    const blockingHost = Layer.succeed(
      WorkingMessageHost,
      WorkingMessageHost.of({
        set: (message) =>
          Effect.suspend(() => {
            observed.push(message);
            return observed.length === 1
              ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
              : Effect.succeed(true);
          }),
      }),
    );
    const blockingTimer = WorkingTimerService.layer.pipe(Layer.provide(blockingHost));
    const scope = yield* Scope.make();

    yield* Effect.gen(function* () {
      const context = yield* Layer.buildWithScope(blockingTimer, scope);
      const service = Context.get(context, WorkingTimerService);
      const startup = yield* service.start.pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(startup);
      yield* TestClock.adjust(5_000);
      expect(observed).toEqual(["Working · 0s"]);
    }).pipe(Effect.ensuring(Scope.close(scope, Exit.void)));

    expect(observed).toEqual(["Working · 0s", undefined]);
  }),
);

layer(timer)("working timer", (it) => {
  it.effect("replaces and stops repeated timer lifecycles without duplicate ticks", () =>
    Effect.gen(function* () {
      messages.length = 0;
      const service = yield* WorkingTimerService;
      yield* service.start;
      yield* service.start;
      yield* TestClock.adjust(1_000);
      expect(messages.filter((message) => message === "Working · 1s")).toHaveLength(1);

      yield* service.stop;
      const firstStoppedCount = messages.length;
      yield* TestClock.adjust(5_000);
      expect(messages).toHaveLength(firstStoppedCount);

      yield* service.start;
      expect(messages.at(-1)).toBe("Working · 0s");
      yield* TestClock.adjust(1_000);
      expect(messages.at(-1)).toBe("Working · 1s");

      yield* service.stop;
      yield* service.stop;
      const finalStoppedCount = messages.length;
      yield* TestClock.adjust(5_000);
      expect(messages).toHaveLength(finalStoppedCount);
    }),
  );

  it.effect("updates once per second and restores Pi's default when stopped", () =>
    Effect.gen(function* () {
      messages.length = 0;
      const service = yield* WorkingTimerService;
      yield* service.start;
      expect(messages).toEqual(["Working · 0s"]);

      yield* TestClock.adjust(5_000);
      expect(messages.at(-1)).toBe("Working · 5s");

      yield* service.recordOutputCharacters(40);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(1_000);
      expect(messages.at(-1)).toBe("Working · 6s · ~10.0 tok/s");

      yield* service.pauseOutput;
      yield* TestClock.adjust(5_000);
      expect(messages.at(-1)).toBe("Working · 11s · ~10.0 tok/s");

      yield* service.recordOutputCharacters(40);
      yield* TestClock.adjust(1_000);
      expect(messages.at(-1)).toBe("Working · 12s · ~10.0 tok/s");

      yield* service.stop;
      expect(messages.at(-1)).toBeUndefined();
      const stoppedCount = messages.length;
      yield* TestClock.adjust(5_000);
      expect(messages).toHaveLength(stoppedCount);
    }),
  );
});
