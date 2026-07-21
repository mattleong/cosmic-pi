import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { AdvisorPlatform } from "./boundary/executor.ts";
import {
  getAdvisorConfigPath,
  loadAdvisorConfigEffect,
  writeAdvisorConfigPatchEffect,
  type AdvisorConfigPatch,
  type ResolvedAdvisorConfig,
} from "./config.ts";

export class AdvisorConfigRepositoryError extends Schema.TaggedErrorClass<AdvisorConfigRepositoryError>()(
  "AdvisorConfigRepositoryError",
  { operation: Schema.String, message: Schema.String },
) {}

export interface ConfigRepositoryShape {
  readonly load: (
    path?: string,
  ) => Effect.Effect<ResolvedAdvisorConfig, AdvisorConfigRepositoryError>;
  readonly patch: (
    patch: AdvisorConfigPatch,
    path?: string,
    afterCommit?: (next: ResolvedAdvisorConfig) => Effect.Effect<void>,
  ) => Effect.Effect<ResolvedAdvisorConfig, AdvisorConfigRepositoryError>;
}

export class ConfigRepository extends Context.Service<ConfigRepository, ConfigRepositoryShape>()(
  "pi-advisor/config-repository/ConfigRepository",
) {}

const repositoryError = (operation: string) => () =>
  new AdvisorConfigRepositoryError({
    operation,
    message: `Advisor configuration ${operation} failed.`,
  });

export const configRepositoryLayer = Layer.effect(
  ConfigRepository,
  Effect.gen(function* () {
    const platform = yield* Effect.context<AdvisorPlatform>();
    return ConfigRepository.of({
      load: (path = getAdvisorConfigPath()) =>
        loadAdvisorConfigEffect(path).pipe(
          Effect.mapError(repositoryError("load")),
          Effect.provide(platform),
        ),
      patch: (patch, path = getAdvisorConfigPath(), afterCommit) =>
        writeAdvisorConfigPatchEffect(patch, path, afterCommit).pipe(
          Effect.mapError(repositoryError("update")),
          Effect.provide(platform),
        ),
    });
  }),
);

/** Converts the legacy Promise-shaped test seam once at the application boundary. */
export const configRepositoryTestLayer = (
  load: (path?: string) => ResolvedAdvisorConfig | Promise<ResolvedAdvisorConfig>,
) =>
  Layer.effect(
    ConfigRepository,
    Effect.gen(function* () {
      const platform = yield* Effect.context<AdvisorPlatform>();
      return ConfigRepository.of({
        load: (path = getAdvisorConfigPath()) =>
          Effect.tryPromise({
            try: () => Promise.resolve(load(path)),
            catch: repositoryError("load"),
          }),
        patch: (patch, path = getAdvisorConfigPath(), afterCommit) =>
          writeAdvisorConfigPatchEffect(patch, path, afterCommit).pipe(
            Effect.mapError(repositoryError("update")),
            Effect.provide(platform),
          ),
      });
    }),
  );
