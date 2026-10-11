import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import {
  clearCodePreviewSessionCapability,
  installCodePreviewSessionCapability,
  type CodePreviewSessionCapability,
} from "../src/application/capability";
import { previewScheduleEffect } from "../src/application/scheduler";
import { codePreviewApplicationLayer } from "../src/layer";
import { CodePreviewSyntaxService } from "../src/syntax/service";

export function startBenchmarkShikiSession(theme: string): Promise<() => Promise<void>> {
  const runtime = ManagedRuntime.make(codePreviewApplicationLayer);
  return runtime
    .runPromise(CodePreviewSyntaxService.use((service) => service.initialize(theme)))
    .then(() => {
      const capability: CodePreviewSessionCapability = {
        run: (effect, signal) => runtime.runPromise(effect, signal ? { signal } : undefined),
        defer: (task) => {
          const fiber = runtime.runFork(Effect.yieldNow.pipe(Effect.andThen(Effect.sync(task))));
          return () => fiber.interruptUnsafe();
        },
        schedule: (interval, task) => {
          const fiber = runtime.runFork(previewScheduleEffect(interval, task));
          return () => fiber.interruptUnsafe();
        },
      };
      installCodePreviewSessionCapability(capability);
      return () => {
        clearCodePreviewSessionCapability();
        return runtime.dispose();
      };
    });
}
