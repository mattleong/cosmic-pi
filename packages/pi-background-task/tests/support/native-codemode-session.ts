// Public SDK host boundary: real agent loop, nested tool hooks and native QuickJS; no inference.
import * as Effect from "effect/Effect";
import { fauxCodemodeSession } from "pi-cosmic-core/testing/sdk";
import type { BackgroundTaskServiceContract } from "../../src/task/service.ts";
import { registerBackgroundTaskTool } from "../../src/tools/background-task.ts";
import { provideTaskService } from "./task-service-double.ts";

/**
 * A scoped in-memory Pi session with native `codemode` and the registered `background_task`
 * definition. Tests supply only the owned task service; the runner adds Path.
 */
export const nativeCodemodeSession = (service: BackgroundTaskServiceContract) =>
  Effect.gen(function* () {
    // Tool calls run with the test's own services plus the owned task boundary.
    const runTool = Effect.runPromiseWith(yield* Effect.context<never>());
    return yield* fauxCodemodeSession({
      prefix: "background-task-workflow-",
      provider: "background-task-workflow-test",
      extension: {
        name: "background-task-workflow-test",
        factory: () => (pi) =>
          registerBackgroundTaskTool(pi, {
            run: (effect, signal) =>
              runTool(provideTaskService(service)(effect), signal ? { signal } : undefined),
          }),
      },
    });
  });
