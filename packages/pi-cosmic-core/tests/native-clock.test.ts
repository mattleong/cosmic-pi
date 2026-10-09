import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vitest";
import { synchronousMonotonicNow, synchronousNow } from "../src/platform/native-clock.ts";

it.live("elapsed readings ignore wall-clock corrections without changing timestamp semantics", () =>
  Effect.gen(function* () {
    const wall = yield* Effect.acquireRelease(
      Effect.sync(() => vi.spyOn(Date, "now")),
      (spy) => Effect.sync(() => spy.mockRestore()),
    );
    const before = synchronousMonotonicNow();
    for (const timestamp of [0, 4_000_000_000_000, 1_000]) {
      wall.mockReturnValue(timestamp);
      expect(synchronousNow()).toBe(timestamp);
      const elapsed = synchronousMonotonicNow() - before;
      expect(elapsed).toBeGreaterThanOrEqual(0);
      // A wide liveness margin, not a timer precision benchmark. Wall-clock deltas are enormous.
      expect(elapsed).toBeLessThan(60_000);
    }
  }),
);
