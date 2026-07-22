import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { AdvisorPlatform } from "../boundary/executor.ts";
import {
  getAdvisorConfigPath,
  loadAdvisorConfigEffect,
  writeAdvisorConfigPatchEffect,
  type AdvisorConfigPatch,
  type ResolvedAdvisorConfig,
} from "./options.ts";

export class AdvisorConfigStoreError extends Schema.TaggedErrorClass<AdvisorConfigStoreError>()(
  "AdvisorConfigStoreError",
  { operation: Schema.String, message: Schema.String },
) {}

export interface ConfigStoreShape {
  readonly load: (path?: string) => Effect.Effect<ResolvedAdvisorConfig, AdvisorConfigStoreError>;
  readonly patch: (
    patch: AdvisorConfigPatch,
    path?: string,
    afterCommit?: (next: ResolvedAdvisorConfig) => Effect.Effect<void>,
  ) => Effect.Effect<ResolvedAdvisorConfig, AdvisorConfigStoreError>;
}

export class ConfigStore extends Context.Service<ConfigStore, ConfigStoreShape>()(
  "pi-advisor/config/store/ConfigStore",
) {}

const storeError = (operation: string) => () =>
  new AdvisorConfigStoreError({
    operation,
    message: `Advisor configuration ${operation} failed.`,
  });

export const configStoreLayer = Layer.effect(
  ConfigStore,
  Effect.gen(function* () {
    const platform = yield* Effect.context<AdvisorPlatform>();
    return ConfigStore.of({
      load: (path = getAdvisorConfigPath()) =>
        loadAdvisorConfigEffect(path).pipe(
          Effect.mapError(storeError("load")),
          Effect.provide(platform),
        ),
      patch: (patch, path = getAdvisorConfigPath(), afterCommit) =>
        writeAdvisorConfigPatchEffect(patch, path, afterCommit).pipe(
          Effect.mapError(storeError("update")),
          Effect.provide(platform),
        ),
    });
  }),
);

/** Converts the legacy Promise-shaped test seam once at the application boundary. */
export const configStoreTestLayer = (
  load: (path?: string) => ResolvedAdvisorConfig | Promise<ResolvedAdvisorConfig>,
) =>
  Layer.effect(
    ConfigStore,
    Effect.gen(function* () {
      const platform = yield* Effect.context<AdvisorPlatform>();
      return ConfigStore.of({
        load: (path = getAdvisorConfigPath()) =>
          Effect.tryPromise({
            try: () => Promise.resolve(load(path)),
            catch: storeError("load"),
          }),
        patch: (patch, path = getAdvisorConfigPath(), afterCommit) =>
          writeAdvisorConfigPatchEffect(patch, path, afterCommit).pipe(
            Effect.mapError(storeError("update")),
            Effect.provide(platform),
          ),
      });
    }),
  );
