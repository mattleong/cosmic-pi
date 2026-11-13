import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Semaphore from "effect/Semaphore";
import { turnInputGates } from "../../src/run/turn-input.ts";
import { view } from "../fixtures/run-view.ts";
import {
  makeRunContext,
  runningAssignment,
  runRecordFixture,
  quietDelivery,
  testSettlement,
} from "./fixtures/run-context.ts";
import { yieldTurns } from "./fixtures/service-harness.ts";

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

  it.effect("settles only after input admitted while it drained has drained too", () =>
    Effect.gen(function* () {
      const context = yield* makeRunContext();
      const gates = turnInputGates(context.withLock);
      const record = yield* runRecordFixture({
        view: view({ state: "running" }),
        assignment: runningAssignment(1),
      });
      let claims = 0;
      const settlement = testSettlement(context, {
        delivery: quietDelivery,
        claimTurnInputDrain: (claimed, drained) => {
          gates.claimTurnInputDrain(claimed, drained);
          // Guidance is admitted once the first drain has completed, before the report commits.
          if (++claims === 1) gates.admitTurnInput(claimed);
        },
      });

      const settling = yield* settlement
        .runSettledFromBackend(record, 1, { stopReason: "stop", text: "Report." })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* yieldTurns(25);
      expect(record.view.state).toBe("running");

      yield* gates.releaseTurnInput(record);
      yield* Fiber.join(settling);
      expect(record.view.state).toBe("completed");
      expect(record.view.finalText).toBe("Report.");
      expect(claims).toBe(3);
    }),
  );
});
