// Benchmark-only scoped runtime; production rendering never creates a runtime.
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { ShikiAdapter } from "../src/boundary/shiki";
import {
  clearCodePreviewSessionCapability,
  installCodePreviewSessionCapability,
  type CodePreviewSessionCapability,
} from "../src/application/capability";
import { previewScheduleEffect } from "../src/application/scheduler";
import { CodePreviewSyntaxService } from "../src/syntax/service";

export function startBenchmarkShikiSession(theme: string): Promise<() => Promise<void>> {
  const layer = CodePreviewSyntaxService.layer.pipe(Layer.provide(ShikiAdapter.layer));
  const runtime = ManagedRuntime.make(layer);
  return runtime
    .runPromise(CodePreviewSyntaxService.use((service) => service.initialize(theme)))
    .then(() => {
      // SAFETY: This test double intentionally implements the host contract surface exercised by this scenario.
      const capability = {
        run: <A, E>(effect: Effect.Effect<A, E, never>, signal?: AbortSignal) =>
          runtime.runPromise(effect, signal ? { signal } : undefined),
        defer: (task: () => void) => {
          const fiber = runtime.runFork(Effect.yieldNow.pipe(Effect.andThen(Effect.sync(task))));
          return () => fiber.interruptUnsafe();
        },
        schedule: (interval: number, task: () => void) => {
          const fiber = runtime.runFork(previewScheduleEffect(interval, task));
          return () => fiber.interruptUnsafe();
        },
      } as CodePreviewSessionCapability;
      installCodePreviewSessionCapability(capability);
      return () => {
        clearCodePreviewSessionCapability();
        return runtime.dispose();
      };
    });
}
