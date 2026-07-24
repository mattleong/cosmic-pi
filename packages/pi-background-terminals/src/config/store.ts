import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  AgentDirectory,
  decodeTolerantFields,
  readConfigOrWarn,
  readOptionalJsonObject,
  scopedDocumentPaths,
  selectScopedDocument,
} from "pi-cosmic-core";
import { normalizeConfig } from "./options.ts";
import { FiniteNumberSchema, type BackgroundTerminalConfig } from "./schema.ts";

const CONFIG_BASENAME = "pi-background-terminals.json";

export class BackgroundTerminalConfigError extends Schema.TaggedErrorClass<BackgroundTerminalConfigError>()(
  "BackgroundTerminalConfigError",
  { operation: Schema.String, path: Schema.String, message: Schema.String },
) {}

const mapDocumentError = (operation: string, path: string) => () =>
  new BackgroundTerminalConfigError({
    operation,
    path,
    message: `Unable to ${operation} Background Terminals configuration.`,
  });

function decodeConfig(value: unknown): Partial<BackgroundTerminalConfig> {
  return decodeTolerantFields(
    value,
    {
      enabled: Schema.Boolean,
      maxRunning: FiniteNumberSchema,
      maxRetained: FiniteNumberSchema,
      logBufferBytesPerJob: FiniteNumberSchema,
      totalLogBufferBytes: FiniteNumberSchema,
      stopGraceMs: FiniteNumberSchema,
      maxLogWaitSeconds: FiniteNumberSchema,
      showFooterStatus: Schema.Boolean,
      shellPath: Schema.String,
    },
    { path: "config" },
  ).value;
}

const readConfig = Effect.fn("BackgroundTerminalConfig.read")(function* (path: string) {
  return yield* readOptionalJsonObject(path, decodeConfig, mapDocumentError);
});

export class BackgroundTerminalConfigStore extends Context.Service<
  BackgroundTerminalConfigStore,
  BackgroundTerminalConfig
>()("pi-background-terminals/config/store/BackgroundTerminalConfigStore") {
  static readonly layer = (options: { readonly cwd: string; readonly projectTrusted: boolean }) =>
    Layer.effect(
      this,
      Effect.gen(function* () {
        const agentDirectory = yield* AgentDirectory;
        const paths = yield* scopedDocumentPaths(options.cwd, agentDirectory, {
          projectConfigDirectory: CONFIG_DIR_NAME,
          basename: CONFIG_BASENAME,
        });
        const selected = yield* selectScopedDocument(paths).pipe(
          Effect.mapError((error) => mapDocumentError("inspect", error.path)()),
        );
        const warning = "Unable to read Background Terminals configuration.";
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
