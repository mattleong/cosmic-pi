import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  AgentDirectory,
  decodeTolerantFields,
  makeConfigDocumentErrorFactory,
  makeScopedConfigStore,
  type JsonObject,
} from "pi-cosmic-core";
import { normalizeConfig } from "./options.ts";
import type { BackgroundTaskConfig } from "./schema.ts";

export class BackgroundTaskConfigError extends Schema.TaggedError<BackgroundTaskConfigError>()(
  "BackgroundTaskConfigError",
  { operation: Schema.String, path: Schema.String, message: Schema.String },
) {}

const decodeConfig = (value: JsonObject): Partial<BackgroundTaskConfig> =>
  decodeTolerantFields(
    value,
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
  ).value;

// No default document, so resolution never writes; untrusted projects are never probed.
const store = makeScopedConfigStore({
  errorFactory: makeConfigDocumentErrorFactory(BackgroundTaskConfigError, "Background Tasks"),
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
