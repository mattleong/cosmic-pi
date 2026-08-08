/** Effect-typed test layers for the Advisor service composition. Test-only; never shipped. */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { AdvisorPlatform } from "../../src/boundary/executor.ts";
import { getAdvisorConfigPath, type ResolvedAdvisorConfig } from "../../src/config/options.ts";
import {
  AdvisorConfigStoreError,
  ConfigStore,
  writeAdvisorConfigPatchEffect,
} from "../../src/config/store.ts";
import type { AdvisorFailureDetails } from "../../src/logging/log.ts";
import { FailureLogger } from "../../src/logging/logger.ts";

/**
 * A ConfigStore layer whose load projection is the given pure function; patches keep the
 * production document write path so persistence behavior stays authentic.
 */
export const configStoreLayerFromLoad = (
  load: (path?: string) => ResolvedAdvisorConfig,
): Layer.Layer<ConfigStore, never, AdvisorPlatform> =>
  Layer.effect(
    ConfigStore,
    Effect.gen(function* () {
      const platform = yield* Effect.context<AdvisorPlatform>();
      return ConfigStore.of({
        load: (path = getAdvisorConfigPath()) =>
          Effect.try({
            try: () => load(path),
            catch: () =>
              new AdvisorConfigStoreError({
                operation: "load",
                message: "Advisor configuration load failed.",
              }),
          }),
        patch: (patch, path = getAdvisorConfigPath(), afterCommit) =>
          writeAdvisorConfigPatchEffect(patch, path, afterCommit).pipe(
            Effect.mapError(
              () =>
                new AdvisorConfigStoreError({
                  operation: "update",
                  message: "Advisor configuration update failed.",
                }),
            ),
            Effect.provide(platform),
          ),
      });
    }),
  );

/** A synchronous fail-open FailureLogger layer around a test-owned log callback. */
export const failureLoggerLayerFromLog = (
  log: (configPath: string, details: AdvisorFailureDetails) => string | undefined,
): Layer.Layer<FailureLogger> =>
  Layer.succeed(
    FailureLogger,
    FailureLogger.of({
      log: (configPath, details) =>
        Effect.sync(() => {
          try {
            return log(configPath, details);
          } catch {
            return undefined;
          }
        }),
    }),
  );
