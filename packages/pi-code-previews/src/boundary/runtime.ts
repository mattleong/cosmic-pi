import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { makePiRuntime, type PiApi } from "pi-cosmic-core";
import { synchronousNow } from "./clock";

export function makeCodePreviewRuntime<R, E>(pi: ExtensionAPI, layer: Layer.Layer<R, E>) {
  const runtime = makePiRuntime(pi, layer);
  return {
    run<A, E2>(effect: Effect.Effect<A, E2, PiApi | R>, signal?: AbortSignal) {
      return runtime.runPromise(effect, signal ? { signal } : undefined);
    },
    fork<A, E2>(effect: Effect.Effect<A, E2, PiApi | R>, signal?: AbortSignal) {
      return runtime.runFork(effect, signal ? { signal } : undefined);
    },
    dispose() {
      return runtime.dispose();
    },
  };
}

export type CodePreviewRuntime = ReturnType<typeof makeCodePreviewRuntime>;
let activeRuntime: CodePreviewRuntime | undefined;

export function setActiveCodePreviewRuntime(runtime: CodePreviewRuntime | undefined): void {
  activeRuntime = runtime;
}

export function previewNow(): number {
  return synchronousNow();
}

export function deferPreview(task: () => void): void {
  const effect = Effect.yieldNow.pipe(Effect.andThen(Effect.sync(task)));
  if (!activeRuntime) {
    Effect.runFork(effect);
    return;
  }
  activeRuntime.fork(effect);
}

/** Fixed cadence avoids recursive-sleep drift while remaining TestClock driven. */
export const previewScheduleEffect = (interval: number, task: () => void) =>
  Effect.sleep(interval).pipe(
    Effect.andThen(Effect.repeat(Effect.sync(task), Schedule.fixed(interval))),
    Effect.asVoid,
  );

export function schedulePreview(interval: number, task: () => void): () => void {
  const effect = previewScheduleEffect(interval, task);
  const fiber = activeRuntime ? activeRuntime.fork(effect) : Effect.runFork(effect);
  return () => fiber.interruptUnsafe();
}
