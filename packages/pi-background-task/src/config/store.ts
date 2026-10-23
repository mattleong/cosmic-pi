import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Path from "effect/Path";
import {
  AgentDirectory,
  type JsonDocumentStore,
  decodeTolerantFields,
  makeScopedConfigStore,
  type JsonObject,
} from "pi-cosmic-core";
import { normalizeConfig } from "./options.ts";
import {
  BackgroundTaskConfigSchema,
  type BackgroundTaskConfig,
  type BackgroundTaskSettingId,
  type BackgroundTaskSettingValue,
} from "./schema.ts";

export class BackgroundTaskConfigError extends Schema.TaggedError<
  BackgroundTaskConfigError,
  { readonly brand: unique symbol }
>()("BackgroundTaskConfigError", {
  operation: Schema.String,
  path: Schema.String,
  message: Schema.String,
}) {}

// Fields decode independently: a wrong-typed value falls back alone, keeping the rest of the file.
const decodeConfigFields = decodeTolerantFields(BackgroundTaskConfigSchema.fields, {
  path: "config",
});

const decodeConfig = (value: JsonObject): Partial<BackgroundTaskConfig> =>
  decodeConfigFields(value).value;

const store = makeScopedConfigStore({
  error: BackgroundTaskConfigError,
  label: "Background Tasks",
  spanPrefix: "BackgroundTaskConfig",
  projectConfigDirectory: CONFIG_DIR_NAME,
  basename: "pi-background-task.json",
  decode: decodeConfig,
  resolve: (metadata, project, global) => ({
    ...metadata,
    config: normalizeConfig({ ...global, ...project }),
  }),
});

export interface BackgroundTaskSettingsLocation {
  readonly cwd: string;
  readonly scope: "global" | "project";
}

export interface BackgroundTaskSettingsFilesContract {
  readonly read: (
    location: BackgroundTaskSettingsLocation,
  ) => Effect.Effect<Partial<BackgroundTaskConfig>, BackgroundTaskConfigError>;
  /** Sets one field in the scope's file; `undefined` removes it so the scope inherits. */
  readonly write: <Id extends BackgroundTaskSettingId>(
    location: BackgroundTaskSettingsLocation,
    id: Id,
    value: BackgroundTaskSettingValue<Id> | undefined,
  ) => Effect.Effect<void, BackgroundTaskConfigError>;
}

export class BackgroundTaskSettingsFiles extends Context.Service<
  BackgroundTaskSettingsFiles,
  BackgroundTaskSettingsFilesContract
>()("pi-background-task/config/store/BackgroundTaskSettingsFiles") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const directory = yield* AgentDirectory;
      const services = yield* Effect.context<JsonDocumentStore | Path.Path>();
      const pathOf = (location: BackgroundTaskSettingsLocation) =>
        store
          .configPaths(location.cwd, directory)
          .pipe(
            Effect.map((paths) => (location.scope === "project" ? paths.project : paths.global)),
          );
      return {
        read: (location) =>
          pathOf(location).pipe(
            Effect.flatMap(store.readConfig),
            Effect.map((values) => values ?? {}),
            Effect.provide(services),
          ),
        write: (location, id, value) =>
          pathOf(location).pipe(
            Effect.flatMap((path) =>
              store.modifyConfig(path, (document) => ({
                value: undefined,
                document:
                  value === undefined
                    ? Object.fromEntries(Object.entries(document).filter(([key]) => key !== id))
                    : { ...document, [id]: value },
              })),
            ),
            Effect.provide(services),
          ),
      };
    }),
  );
}

export class BackgroundTaskConfigStore extends Context.Service<
  BackgroundTaskConfigStore,
  BackgroundTaskConfig
>()("pi-background-task/config/store/BackgroundTaskConfigStore") {
  static readonly layer = (options: { readonly cwd: string; readonly projectTrusted: boolean }) =>
    Layer.effect(
      this,
      AgentDirectory.use((directory) =>
        store.resolveConfig(options.cwd, directory, options.projectTrusted),
      ).pipe(Effect.map(({ config }) => config)),
    );
}
