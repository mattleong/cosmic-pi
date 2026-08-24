// Benchmark-only scoped runtime; production rendering never creates a runtime.
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Predicate from "effect/Predicate";
import { ShikiAdapter } from "../src/boundary/shiki";
import {
  clearCodePreviewSessionCapability,
  installCodePreviewSessionCapability,
  type CodePreviewSessionCapability,
} from "../src/application/capability";
import { previewScheduleEffect } from "../src/application/scheduler";
import { CodePreviewEnvironmentService } from "../src/config/env";
import { CodePreviewSyntaxService } from "../src/syntax/service";

/**
 * Snapshot of the current environment for benchmark-scoped environment layers.
 * Reading through `Object.entries` keeps the snapshot explicit and validated.
 */
function environmentSnapshot(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).flatMap(([key, value]) =>
      Predicate.isString(value) ? [[key, value]] : [],
    ),
  );
}

export function startBenchmarkShikiSession(
  theme: string,
  environmentOptions: {
    /** Values used only when the ambient environment does not define them. */
    defaults?: Readonly<Record<string, string>>;
    /** Values forced over the ambient environment. */
    overrides?: Readonly<Record<string, string>>;
  } = {},
): Promise<() => Promise<void>> {
  const layer = Layer.merge(
    CodePreviewSyntaxService.layer.pipe(Layer.provide(ShikiAdapter.layer)),
    CodePreviewEnvironmentService.layerFrom({
      ...environmentOptions.defaults,
      ...environmentSnapshot(),
      ...environmentOptions.overrides,
    }),
  );
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
