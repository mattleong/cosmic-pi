import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import { invokeHostCallback } from "pi-cosmic-core";

export interface CodePreviewSchedulerServiceContract {
  readonly defer: (task: () => void) => () => void;
  readonly schedule: (interval: number, task: () => void) => () => void;
}

const invokeCodePreviewCallback = (task: () => void): Effect.Effect<void> =>
  Effect.sync(() => invokeHostCallback(task, undefined));

export const previewScheduleEffect = (interval: number, task: () => void) =>
  invokeCodePreviewCallback(task).pipe(
    Effect.schedule(Schedule.fixed(Duration.millis(interval))),
    Effect.asVoid,
  );

const makeScheduler = Effect.gen(function* () {
  const run = yield* FiberSet.makeRuntime();
  // Deferred previews take turns, each after its own yield, so a burst of them cannot hold the
  // event loop for their combined duration.
  const takeTurn = Semaphore.withPermit(yield* Semaphore.make(1));
  const start = (effect: Effect.Effect<void>): (() => void) => {
    const fiber = run(effect);
    return () => fiber.interruptUnsafe();
  };
  return CodePreviewSchedulerService.of({
    defer: (task) =>
      start(takeTurn(Effect.yieldNow.pipe(Effect.andThen(invokeCodePreviewCallback(task))))),
    schedule: (interval, task) => start(previewScheduleEffect(interval, task)),
  });
});

export class CodePreviewSchedulerService extends Context.Service<
  CodePreviewSchedulerService,
  CodePreviewSchedulerServiceContract
>()("pi-code-previews/application/scheduler/CodePreviewSchedulerService") {
  static readonly layer = Layer.effect(this, makeScheduler);
}
