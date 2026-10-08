import { describe, expect, it } from "@effect/vitest";
import { yieldUntil } from "pi-cosmic-core/testing";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { makeWorkflowSlots, type WorkflowWait } from "../../src/workflow/admission-queue.ts";

const patient: WorkflowWait = { onWait: Effect.void, abort: Effect.never };

describe("workflow slots", () => {
  it.effect("grants slots in queue order, so an earlier call that comes back goes first", () =>
    Effect.gen(function* () {
      const slots = makeWorkflowSlots(1);
      const granted: string[] = [];
      let waiting = 0;
      const wait: WorkflowWait = {
        onWait: Effect.sync(() => void (waiting += 1)),
        abort: Effect.never,
      };
      const finish = new Map<string, Deferred.Deferred<void>>();
      const hold = (label: string, queuedAt: number) =>
        Effect.gen(function* () {
          const done = yield* Deferred.make<void>();
          finish.set(label, done);
          return yield* slots
            .hold(
              slots.order(queuedAt),
              wait,
              Effect.sync(() => void granted.push(label)).pipe(
                Effect.andThen(Deferred.await(done)),
              ),
            )
            .pipe(Effect.forkChild);
        });
      yield* hold("first", 0);
      yield* yieldUntil(() => granted.length === 1);
      // Calls queued at the same time keep their call order; a call queued earlier, such as one
      // back from waiting behind a writer, goes ahead of them even though it arrives last.
      yield* hold("second", 5);
      yield* hold("third", 5);
      yield* hold("earlier", 3);
      yield* yieldUntil(() => waiting === 3);
      for (let count = 1; count <= 4; count++) {
        yield* yieldUntil(() => granted.length === count);
        yield* Deferred.succeed(finish.get(granted.at(-1)!)!, undefined);
      }
      expect(granted).toEqual(["first", "earlier", "second", "third"]);
      // Only the calls that couldn't take a slot on arrival waited, each once.
      expect(waiting).toBe(3);
    }),
  );

  it.effect("runs as many holders at once as it has slots", () =>
    Effect.gen(function* () {
      const slots = makeWorkflowSlots(2);
      const running = new Set<number>();
      let most = 0;
      const release = yield* Deferred.make<void>();
      const fibers = yield* Effect.forEach([0, 1, 2, 3, 4], (index) =>
        slots
          .hold(
            slots.order(index),
            patient,
            Effect.sync(() => {
              running.add(index);
              most = Math.max(most, running.size);
            }).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.ensuring(Effect.sync(() => void running.delete(index))),
            ),
          )
          .pipe(Effect.forkChild),
      );
      yield* yieldUntil(() => running.size === 2);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.joinAll(fibers);
      expect(most).toBe(2);
    }),
  );

  it.effect("leaves cleanly when a waiter is interrupted or its wait is aborted", () =>
    Effect.gen(function* () {
      const slots = makeWorkflowSlots(1);
      const granted: string[] = [];
      const hold = (label: string, wait: WorkflowWait = patient) =>
        slots.hold(
          slots.order(0),
          wait,
          Effect.sync(() => void granted.push(label)).pipe(Effect.andThen(Effect.never)),
        );
      const holder = yield* hold("holder").pipe(Effect.forkChild);
      yield* yieldUntil(() => granted.length === 1);
      const interrupted = yield* hold("interrupted").pipe(Effect.forkChild);
      const abort = yield* Deferred.make<void>();
      const aborted = yield* hold("aborted", {
        onWait: Effect.void,
        abort: Deferred.await(abort),
      }).pipe(Effect.forkChild);
      const next = yield* hold("next").pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(interrupted);
      yield* Deferred.succeed(abort, undefined);
      expect(Option.isNone(yield* Fiber.join(aborted))).toBe(true);
      // Neither left a slot behind, so the next waiter takes the holder's place.
      yield* Fiber.interrupt(holder);
      yield* yieldUntil(() => granted.length === 2);
      expect(granted).toEqual(["holder", "next"]);
      yield* Fiber.interrupt(next);
    }),
  );
});
