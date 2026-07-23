import { expect, it, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
  expect(formatWorkingMessage(10_000, 400, 2_000)).toBe(
    "Working · 10s · ~50.0 tok/s",
  );
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

layer(timer)("working timer", (it) => {
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
      yield* TestClock.adjust(2_000);
      expect(messages.at(-1)).toBe("Working · 8s · ~3.3 tok/s");

      yield* service.stop;
      expect(messages.at(-1)).toBeUndefined();
      const stoppedCount = messages.length;
      yield* TestClock.adjust(5_000);
      expect(messages).toHaveLength(stoppedCount);
    }),
  );
});
