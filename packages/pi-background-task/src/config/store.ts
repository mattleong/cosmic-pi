import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";
import {
  AgentDirectory,
  JsonDocumentStore,
  decodeTolerantFields,
  makeScopedConfigStore,
  type JsonObject,
} from "pi-cosmic-core";
import { normalizeConfig } from "./options.ts";
import type { BackgroundTaskConfig } from "./schema.ts";

export class BackgroundTaskConfigError extends Schema.TaggedError<BackgroundTaskConfigError>()(
  "BackgroundTaskConfigError",
  { operation: Schema.String, path: Schema.String, message: Schema.String },
) {}

const decodeConfigFields = decodeTolerantFields(
  {
    enabled: Schema.Boolean,
    maxRunning: Schema.Finite,
    maxRetained: Schema.Finite,
    logBufferBytesPerTask: Schema.Finite,
    totalLogBufferBytes: Schema.Finite,
    stopGraceMs: Schema.Finite,
    maxWaitSeconds: Schema.Finite,
    showFooterStatus: Schema.Boolean,
    shellPath: Schema.String,
  },
  { path: "config" },
);

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
  readonly write: (
    location: BackgroundTaskSettingsLocation,
    id: keyof BackgroundTaskConfig,
    value: boolean | number | string | undefined,
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
