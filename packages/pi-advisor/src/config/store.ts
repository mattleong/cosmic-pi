import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  JsonDocumentStore,
  makeConfigDocumentErrorFactory,
  type JsonDocumentModification,
  type JsonObject,
} from "pi-cosmic-core";
import type { AdvisorPlatform } from "../boundary/executor.ts";
import {
  AdvisorConfigError,
  getAdvisorConfigPath,
  normalizeAdvisorConfig,
  patchAdvisorConfig,
  type AdvisorConfigPatch,
  type ResolvedAdvisorConfig,
} from "./options.ts";

const mapConfigError = makeConfigDocumentErrorFactory(AdvisorConfigError, "Advisor");

export const readRawAdvisorConfigEffect = Effect.fn("AdvisorConfig.readRaw")(function* (
  path = getAdvisorConfigPath(),
) {
  const documents = yield* JsonDocumentStore;
  // SAFETY: Configuration decoding validates the persisted value before this typed access.
  return yield* documents.readObject(path).pipe(
    Effect.map((value) => value ?? {}),
    Effect.catch((error) =>
      Effect.logWarning(`Advisor config read failed (${error.operation}).`).pipe(
        Effect.as({} as JsonObject),
      ),
    ),
  );
});

export const loadAdvisorConfigEffect = Effect.fn("AdvisorConfig.load")(function* (
  path = getAdvisorConfigPath(),
) {
  return normalizeAdvisorConfig(yield* readRawAdvisorConfigEffect(path), path);
});

const protectAdvisorConfigDirectoryEffect = Effect.fn("AdvisorConfig.protectDirectory")(function* (
  path: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const directory = paths.dirname(path);
  const existed = yield* fs.exists(directory);
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  if (!existed || paths.basename(directory) === "extensions") {
    yield* fs.chmod(directory, 0o700);
  }
});

export const writeAdvisorConfigPatchEffect = Effect.fn("AdvisorConfig.patch")(function* <
  AfterCommitR = never,
>(
  patch: AdvisorConfigPatch,
  path = getAdvisorConfigPath(),
  afterCommit?: (next: ResolvedAdvisorConfig) => Effect.Effect<void, never, AfterCommitR>,
) {
  const documents = yield* JsonDocumentStore;
  yield* protectAdvisorConfigDirectoryEffect(path).pipe(
    Effect.mapError(mapConfigError("protect directory", path)),
  );
  const modifyObject = documents.modifyObject;
  if (modifyObject) {
    return yield* modifyObject(path, (raw) =>
      Effect.try({
        try: () => {
          const document = patchAdvisorConfig(raw, patch);
          const next = normalizeAdvisorConfig(document, path);
          const base = { value: next, document };
          const modification = afterCommit ? { ...base, afterCommit: afterCommit(next) } : base;
          return modification satisfies JsonDocumentModification<
            ResolvedAdvisorConfig,
            AfterCommitR
          >;
        },
        catch: mapConfigError("update", path),
      }),
    ).pipe(Effect.mapError(mapConfigError("update", path)));
  }
  if (afterCommit)
    return yield* new AdvisorConfigError({
      operation: "update",
      path,
      message: "Unable to commit Advisor configuration state atomically.",
    });
  let next: JsonObject | undefined;
  yield* documents
    .updateObject(path, (raw) => {
      next = patchAdvisorConfig(raw, patch);
      return next;
    })
    .pipe(Effect.mapError(mapConfigError("update", path)));
  return normalizeAdvisorConfig(next ?? {}, path);
});

export class AdvisorConfigStoreError extends Schema.TaggedError<AdvisorConfigStoreError>()(
  "AdvisorConfigStoreError",
  { operation: Schema.String, message: Schema.String },
) {}

export interface ConfigStoreContract {
  readonly load: (path?: string) => Effect.Effect<ResolvedAdvisorConfig, AdvisorConfigStoreError>;
  readonly patch: (
    patch: AdvisorConfigPatch,
    path?: string,
    afterCommit?: (next: ResolvedAdvisorConfig) => Effect.Effect<void>,
  ) => Effect.Effect<ResolvedAdvisorConfig, AdvisorConfigStoreError>;
}

export class ConfigStore extends Context.Service<ConfigStore, ConfigStoreContract>()(
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
