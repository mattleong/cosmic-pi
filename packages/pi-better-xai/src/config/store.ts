import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  decodeTolerantFields,
  modifyJsonObject,
  readConfigOrWarn,
  readOptionalJsonObject,
  readRawJsonObject,
  scopedDocumentPaths,
  selectScopedDocument,
  writeJsonObject,
  type JsonDocumentModification,
  type JsonObject,
} from "pi-cosmic-core";
import { CONFIG_BASENAME } from "../auth/identity.ts";
import {
  DEFAULT_FOOTER_CONFIG,
  DEFAULT_USAGE_CONFIG,
  FiniteNumberSchema,
  FooterModeSchema,
  type ResolvedConfig,
} from "./schema.ts";

export class XaiConfigError extends Schema.TaggedErrorClass<XaiConfigError>()("XaiConfigError", {
  operation: Schema.String,
  path: Schema.String,
  message: Schema.String,
}) {}

function mapDocumentError(operation: string, path: string) {
  return () =>
    new XaiConfigError({
      operation,
      path,
      message: `Unable to ${operation} Better xAI configuration.`,
    });
}

export const configPaths = Effect.fn("XaiConfig.configPaths")(function* (
  cwd: string,
  agentDir: string,
) {
  return yield* scopedDocumentPaths(cwd, agentDir, {
    projectConfigDirectory: CONFIG_DIR_NAME,
    basename: CONFIG_BASENAME,
  });
});

export const readRawConfig = Effect.fn("XaiConfig.readRawConfig")(function* (path: string) {
  return yield* readRawJsonObject(path, mapDocumentError);
});

const UnknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown);

function decodeConfig(value: unknown) {
  const root = decodeTolerantFields(
    value,
    { usage: UnknownRecordSchema, footer: UnknownRecordSchema },
    { path: "config" },
  ).value;
  const usage = decodeTolerantFields(
    root.usage,
    {
      enabled: Schema.Boolean,
      refreshIntervalMs: FiniteNumberSchema,
      showOnlyOnSubscriptionModels: Schema.Boolean,
      showResetTimes: Schema.Boolean,
    },
    { path: "usage" },
  ).value;
  const footer = decodeTolerantFields(
    root.footer,
    { mode: FooterModeSchema },
    { path: "footer" },
  ).value;
  return {
    ...(Object.keys(usage).length > 0 ? { usage } : {}),
    ...(footer.mode !== undefined ? { footer: { mode: footer.mode } } : {}),
  };
}

type ResolvedConfigValues = Pick<ResolvedConfig, "usage" | "footer">;
type DecodedConfig = ReturnType<typeof decodeConfig>;

const defaultConfigValues = (): ResolvedConfigValues => ({
  usage: { ...DEFAULT_USAGE_CONFIG },
  footer: { ...DEFAULT_FOOTER_CONFIG },
});

function overlayConfigValues(
  primary: DecodedConfig | void,
  fallback: ResolvedConfigValues,
): ResolvedConfigValues {
  const usage = { ...fallback.usage, ...primary?.usage };
  return {
    usage: {
      ...usage,
      refreshIntervalMs: Math.max(5_000, usage.refreshIntervalMs),
    },
    footer: { ...fallback.footer, ...primary?.footer },
  };
}

/** Resolves an atomically committed selected document without another filesystem read. */
export function resolveCommittedConfig(
  current: ResolvedConfig,
  committedDocument: JsonObject,
  globalFallback: JsonObject | undefined,
): ResolvedConfig {
  const fallback =
    current.configPath === current.projectConfigPath
      ? overlayConfigValues(
          globalFallback === undefined ? undefined : decodeConfig(globalFallback),
          defaultConfigValues(),
        )
      : defaultConfigValues();
  return {
    ...current,
    ...overlayConfigValues(decodeConfig(committedDocument), fallback),
  };
}

export const readConfig = Effect.fn("XaiConfig.readConfig")(function* (path: string) {
  return yield* readOptionalJsonObject(path, decodeConfig, mapDocumentError);
});

export const writeConfig = Effect.fn("XaiConfig.writeConfig")(function* (
  path: string,
  config: JsonObject,
) {
  yield* writeJsonObject(path, config, mapDocumentError);
});

export const updateConfig = Effect.fn("XaiConfig.updateConfig")(function* (
  // The callback is part of the store's narrow, uninterruptible rename commit region.
  path: string,
  update: (document: JsonObject) => JsonObject,
  afterCommit: (document: JsonObject) => Effect.Effect<void>,
) {
  return yield* modifyJsonObject(
    path,
    (current) => {
      const next = update(current);
      return {
        value: next,
        document: next,
        afterCommit: afterCommit(next),
      } satisfies JsonDocumentModification<JsonObject>;
    },
    mapDocumentError,
  );
});

const defaultDocument = (): JsonObject => defaultConfigValues();

export const resolveConfig = Effect.fn("XaiConfig.resolveConfig")(function* (
  cwd: string,
  agentDir: string,
  projectTrusted = true,
) {
  const paths = yield* configPaths(cwd, agentDir);
  const selected = yield* selectScopedDocument(paths).pipe(
    Effect.mapError((error) => mapDocumentError("inspect", error.path)()),
  );
  let projectExists = projectTrusted && selected.projectExists;
  let globalExists = selected.globalExists;

  if (!projectExists && !globalExists) {
    yield* writeConfig(paths.global, defaultDocument());
    globalExists = true;
  }

  const warning = "Unable to read a Better xAI configuration document.";
  const project = yield* readConfigOrWarn(paths.project, projectExists, readConfig, warning);
  const global = yield* readConfigOrWarn(paths.global, globalExists, readConfig, warning);
  const globalValues = overlayConfigValues(global, defaultConfigValues());
  const resolved = overlayConfigValues(project, globalValues);

  return {
    configPath: projectExists ? paths.project : paths.global,
    projectConfigPath: paths.project,
    globalConfigPath: paths.global,
    projectConfigExists: projectExists,
    globalConfigExists: globalExists,
    usage: resolved.usage,
    footer: resolved.footer,
  } satisfies ResolvedConfig;
});
