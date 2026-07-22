import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { AdvisorPlatform } from "../boundary/executor.ts";
import { logAdvisorFailureEffect, type AdvisorFailureDetails } from "./log.ts";

export interface FailureLoggerShape {
  readonly log: (
    configPath: string,
    details: AdvisorFailureDetails,
  ) => Effect.Effect<string | undefined>;
}

export class FailureLogger extends Context.Service<FailureLogger, FailureLoggerShape>()(
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

/** Converts the legacy Promise-shaped test seam once at the application boundary. */
export const failureLoggerTestLayer = (
  log: (
    configPath: string,
    details: AdvisorFailureDetails,
  ) => string | undefined | Promise<string | undefined>,
) =>
  Layer.succeed(
    FailureLogger,
    FailureLogger.of({
      log: (configPath, details) =>
        Effect.tryPromise({
          try: () => Promise.resolve(log(configPath, details)),
          catch: () => undefined,
        }).pipe(Effect.catch(() => Effect.sync((): string | undefined => undefined))),
    }),
  );
