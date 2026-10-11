import * as Effect from "effect/Effect";
import { fauxCodemodeSession } from "pi-cosmic-core/testing/sdk";
import type { BackgroundTaskServiceContract } from "../../src/task/service.ts";
import { registerBackgroundTaskTool } from "../../src/tools/background-task.ts";
import { provideTaskService } from "./task-service-double.ts";

export const nativeCodemodeSession = (service: BackgroundTaskServiceContract) =>
  Effect.gen(function* () {
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
