import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import { turnInputGates } from "../../src/run/turn-input.ts";
import { runRecordFixture } from "./fixtures/run-context.ts";

describe("turn-input admission", () => {
  it.effect("releases every waiter, such as an interrupt and a settlement, once input drains", () =>
    Effect.gen(function* () {
      const lock = yield* Semaphore.make(1);
      const gates = turnInputGates(lock.withPermits(1));
      const record = yield* runRecordFixture();
      const interrupt = yield* Deferred.make<void>();
      const settlement = yield* Deferred.make<void>();

      gates.admitTurnInput(record);
      gates.claimTurnInputDrain(record, interrupt);
      gates.claimTurnInputDrain(record, settlement);
      expect(yield* Deferred.isDone(interrupt)).toBe(false);

      yield* gates.releaseTurnInput(record);
      expect(yield* Deferred.isDone(interrupt)).toBe(true);
      expect(yield* Deferred.isDone(settlement)).toBe(true);

      const idle = yield* Deferred.make<void>();
      gates.claimTurnInputDrain(record, idle);
      expect(yield* Deferred.isDone(idle)).toBe(true);
    }),
  );
});
