// Synchronous Pi callback timing is confined here; fibers use Effect Clock.
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schedule from "effect/Schedule";
import type { AdvisorEffectExecutor } from "./executor.ts";

export function advisorNow(executor: Pick<AdvisorEffectExecutor, "now">): number {
  return executor.now();
}
export function advisorIsoNow(executor: Pick<AdvisorEffectExecutor, "now">): string {
  return DateTime.formatIso(DateTime.makeUnsafe(executor.now()));
}
export const advisorDelayEffect = (milliseconds: number, task: () => void) =>
  Effect.sleep(milliseconds).pipe(Effect.andThen(Effect.sync(task)));

export const advisorIntervalEffect = (milliseconds: number, task: () => void) =>
  Effect.sleep(milliseconds).pipe(
    Effect.andThen(Effect.repeat(Effect.sync(task), Schedule.fixed(milliseconds))),
    Effect.asVoid,
  );

export function advisorDelay(
  executor: Pick<AdvisorEffectExecutor, "fork">,
  milliseconds: number,
  task: () => void,
): () => void {
  const fiber = executor.fork(advisorDelayEffect(milliseconds, task));
  return () => fiber.interruptUnsafe();
}
export function advisorInterval(
  executor: Pick<AdvisorEffectExecutor, "fork">,
  milliseconds: number,
  task: () => void,
): () => void {
  const fiber = executor.fork(advisorIntervalEffect(milliseconds, task));
  return () => fiber.interruptUnsafe();
}
export function interruptFiber(fiber: Fiber.Fiber<unknown, unknown> | undefined): void {
  fiber?.interruptUnsafe();
}
