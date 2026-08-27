import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  AgentDirectory,
  decodeTolerantFields,
  makeConfigDocumentErrorFactory,
  readConfigOrWarn,
  readOptionalJsonObject,
  scopedDocumentPaths,
  selectScopedDocument,
} from "pi-cosmic-core";
import { normalizeConfig } from "./options.ts";
import { FiniteNumberSchema, type BackgroundTaskConfig } from "./schema.ts";

const CONFIG_BASENAME = "pi-background-task.json";

export class BackgroundTaskConfigError extends Schema.TaggedError<BackgroundTaskConfigError>()(
  "BackgroundTaskConfigError",
  { operation: Schema.String, path: Schema.String, message: Schema.String },
) {}

const mapDocumentError = makeConfigDocumentErrorFactory(
  BackgroundTaskConfigError,
  "Background Tasks",
);

function decodeConfig<ValueInput>(value: ValueInput): Partial<BackgroundTaskConfig> {
  return decodeTolerantFields(
    value,
    {
      enabled: Schema.Boolean,
      maxRunning: FiniteNumberSchema,
      maxRetained: FiniteNumberSchema,
      logBufferBytesPerTask: FiniteNumberSchema,
      totalLogBufferBytes: FiniteNumberSchema,
      stopGraceMs: FiniteNumberSchema,
      maxWaitSeconds: FiniteNumberSchema,
      showFooterStatus: Schema.Boolean,
      shellPath: Schema.String,
    },
    { path: "config" },
  ).value;
}

const readConfig = Effect.fn("BackgroundTaskConfig.read")(function* (path: string) {
  return yield* readOptionalJsonObject(path, decodeConfig, mapDocumentError);
});

export class BackgroundTaskConfigStore extends Context.Service<
  BackgroundTaskConfigStore,
  BackgroundTaskConfig
>()("pi-background-task/config/store/BackgroundTaskConfigStore") {
  static readonly layer = (options: { readonly cwd: string; readonly projectTrusted: boolean }) =>
    Layer.effect(
      this,
      Effect.gen(function* () {
        const agentDirectory = yield* AgentDirectory;
        const paths = yield* scopedDocumentPaths(options.cwd, agentDirectory, {
          projectConfigDirectory: CONFIG_DIR_NAME,
          basename: CONFIG_BASENAME,
        });
        // Untrusted projects never probe the project document: its path stays inert metadata.
        const selected = yield* selectScopedDocument(paths, {
          probeProject: options.projectTrusted,
        }).pipe(Effect.mapError((error) => mapDocumentError("inspect", error.path)()));
        const warning = "Unable to read Background Tasks configuration.";
        const global = yield* readConfigOrWarn(
          paths.global,
          selected.globalExists,
          readConfig,
          warning,
        );
        const project = yield* readConfigOrWarn(
          paths.project,
          options.projectTrusted && selected.projectExists,
          readConfig,
          warning,
        );
        return normalizeConfig({ ...global, ...project });
      }),
    );
}
