// Synchronous Pi callback timing is confined here; fibers use Effect Clock.
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { AdvisorEffectExecutor } from "./executor.ts";

export function advisorNow(executor: Pick<AdvisorEffectExecutor, "now">): number {
  return executor.now();
}
export class AdvisorClockTaskError extends Schema.TaggedError<AdvisorClockTaskError>()(
  "AdvisorClockTaskError",
  { message: Schema.String },
) {}

const runClockTask = (task: () => void): Effect.Effect<void> =>
  Effect.try({
    try: task,
    catch: () => new AdvisorClockTaskError({ message: "Advisor timer callback failed safely." }),
  }).pipe(Effect.catch(() => Effect.void));

export const advisorDelayEffect = (milliseconds: number, task: () => void) =>
  Effect.sleep(Duration.millis(milliseconds)).pipe(Effect.andThen(runClockTask(task)));

export function advisorDelay(
  executor: Pick<AdvisorEffectExecutor, "fork">,
  milliseconds: number,
  task: () => void,
): () => void {
  const fiber = executor.fork(advisorDelayEffect(milliseconds, task));
  return () => fiber.interruptUnsafe();
}
