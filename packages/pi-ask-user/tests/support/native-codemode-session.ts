import * as Effect from "effect/Effect";
import { fauxCodemodeSession } from "pi-cosmic-core/testing/sdk";
import type { AskUserService } from "../../src/questionnaire/service.ts";
import { registerAskUserTool } from "../../src/tools/ask-user.ts";
import { registerAsyncAskUserTools } from "../../src/tools/ask-user-async.ts";

export const nativeCodemodeSession = (service: Effect.Success<typeof AskUserService>) =>
  Effect.gen(function* () {
    const runTool = Effect.runPromiseWith(yield* Effect.context<never>());
    return yield* fauxCodemodeSession({
      prefix: "ask-user-workflow-",
      provider: "ask-user-workflow-test",
      extension: {
        name: "ask-user-workflow-test",
        factory: () => (pi) => {
          registerAskUserTool(pi, (input, signal) =>
            runTool(service.ask(input), signal ? { signal } : undefined),
          );
          registerAsyncAskUserTools(
            pi,
            (input, signal) => runTool(service.startAsync(input), signal ? { signal } : undefined),
            (input, signal) =>
              runTool(service.controlAsync(input), signal ? { signal } : undefined),
          );
        },
      },
    });
  });
