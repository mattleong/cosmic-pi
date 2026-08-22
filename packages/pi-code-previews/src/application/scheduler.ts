import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

export interface CodePreviewSchedulerServiceContract {
  readonly defer: (task: () => void) => () => void;
  readonly schedule: (interval: number, task: () => void) => () => void;
}

const invokeCodePreviewCallback = (task: () => void): Effect.Effect<void> =>
  Effect.try({ try: task, catch: () => undefined }).pipe(Effect.ignore);

/** Fixed cadence avoids recursive-sleep drift while remaining TestClock driven. */
export const previewScheduleEffect = (interval: number, task: () => void) =>
  Effect.sleep(Duration.millis(interval)).pipe(
    Effect.andThen(
      Effect.repeat(invokeCodePreviewCallback(task), Schedule.fixed(Duration.millis(interval))),
    ),
    Effect.asVoid,
  );

const makeScheduler = Effect.gen(function* () {
  const run = yield* FiberSet.makeRuntime<never>();
  const start = (effect: Effect.Effect<void>): (() => void) => {
    const fiber = run(effect);
    return () => fiber.interruptUnsafe();
  };
  return CodePreviewSchedulerService.of({
    defer: (task) => start(Effect.yieldNow.pipe(Effect.andThen(invokeCodePreviewCallback(task)))),
    schedule: (interval, task) => start(previewScheduleEffect(interval, task)),
  });
});

export class CodePreviewSchedulerService extends Context.Service<
  CodePreviewSchedulerService,
  CodePreviewSchedulerServiceContract
>()("pi-code-previews/application/scheduler/CodePreviewSchedulerService") {
  static readonly layer = Layer.effect(this, makeScheduler);
}
