import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { AdvisorPlatform } from "../boundary/executor.ts";
import { logAdvisorFailureEffect, type AdvisorFailureDetails } from "./log.ts";

export interface FailureLoggerContract {
  readonly log: (
    configPath: string,
    details: AdvisorFailureDetails,
  ) => Effect.Effect<string | undefined>;
}

export class FailureLogger extends Context.Service<FailureLogger, FailureLoggerContract>()(
  "pi-advisor/logging/logger/FailureLogger",
) {}

export const failureLoggerLayer = Layer.effect(
  FailureLogger,
  Effect.gen(function* () {
    const platform = yield* Effect.context<AdvisorPlatform>();
    return FailureLogger.of({
      log: (configPath, details) =>
        logAdvisorFailureEffect(configPath, details).pipe(Effect.provide(platform)),
    });
  }),
);
