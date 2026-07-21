import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  decodeTolerantFields,
  JsonDocumentStore,
  scopedDocumentPaths,
  selectScopedDocument,
  type JsonDocumentModification,
  type JsonObject,
} from "pi-cosmic-core";
import { CONFIG_BASENAME } from "../identity.ts";
import {
  DEFAULT_CONFIG,
  DEFAULT_FOOTER_CONFIG,
  DEFAULT_IMAGE_CONFIG,
  DEFAULT_USAGE_CONFIG,
  FooterModeSchema,
  ImageOutputFormatSchema,
  ImageSaveModeSchema,
  type ConfigFile,
  type ImageConfig,
  type ResolvedConfig,
  type UsageConfig,
} from "./schema.ts";

export class OpenAIConfigError extends Schema.TaggedErrorClass<OpenAIConfigError>()(
  "OpenAIConfigError",
  { operation: Schema.String, path: Schema.String, message: Schema.String },
) {}

const mapError = (operation: string, path: string) => () =>
  new OpenAIConfigError({
    operation,
    path,
    message: `Unable to ${operation} Better OpenAI configuration.`,
  });

export const configPaths = Effect.fn("OpenAIConfig.configPaths")(function* (
  cwd: string,
  agentDir: string,
) {
  return yield* scopedDocumentPaths(cwd, agentDir, {
    projectConfigDirectory: CONFIG_DIR_NAME,
    basename: CONFIG_BASENAME,
  });
});

export const readRawConfig = Effect.fn("OpenAIConfig.readRawConfig")(function* (path: string) {
  const documents = yield* JsonDocumentStore;
  return yield* documents.readObject(path).pipe(
    Effect.mapError(mapError("read", path)),
    Effect.map((value) => value ?? {}),
  );
});

const UnknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
const FiniteNumberSchema = Schema.Number.check(Schema.isFinite());

/** Tolerant field-level wire decode: one malformed field never discards valid siblings. */
function decodeConfig(value: unknown): ConfigFile {
  const root = decodeTolerantFields(
    value,
    {
      persistState: Schema.Boolean,
      active: Schema.Boolean,
      desiredActive: Schema.Boolean,
      usage: UnknownRecordSchema,
      footer: UnknownRecordSchema,
      image: UnknownRecordSchema,
    },
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
  ).value as UsageConfig;
  const footer = decodeTolerantFields(
    root.footer,
    { mode: FooterModeSchema },
    { path: "footer" },
  ).value;
  const imageFields = decodeTolerantFields(
    root.image,
    {
      enabled: Schema.Boolean,
      defaultModel: Schema.String,
      defaultSave: ImageSaveModeSchema,
      outputFormat: ImageOutputFormatSchema,
      timeoutMs: FiniteNumberSchema,
    },
    { path: "image" },
  ).value;
  const defaultModel = imageFields.defaultModel?.trim();
  const image: ImageConfig = {
    ...imageFields,
    ...(defaultModel ? { defaultModel } : { defaultModel: undefined }),
  };
  return {
    ...(root.persistState !== undefined ? { persistState: root.persistState } : {}),
    ...(root.active !== undefined ? { active: root.active } : {}),
    ...(root.desiredActive !== undefined ? { desiredActive: root.desiredActive } : {}),
    ...(Object.keys(usage).length ? { usage } : {}),
    ...(footer.mode !== undefined ? { footer: { mode: footer.mode } } : {}),
    ...(Object.values(image).some((field) => field !== undefined) ? { image } : {}),
  };
}

type ResolvedConfigMetadata = Pick<
  ResolvedConfig,
  | "configPath"
  | "projectConfigPath"
  | "globalConfigPath"
  | "projectConfigExists"
  | "globalConfigExists"
>;

function resolveConfigFiles(
  metadata: ResolvedConfigMetadata,
  project: ConfigFile | undefined,
  global: ConfigFile | undefined,
): ResolvedConfig {
  const desiredActive =
    project?.desiredActive ??
    project?.active ??
    global?.desiredActive ??
    global?.active ??
    DEFAULT_CONFIG.desiredActive ??
    false;
  return {
    ...metadata,
    persistState:
      project?.persistState ?? global?.persistState ?? DEFAULT_CONFIG.persistState ?? true,
    active: project?.active ?? global?.active ?? desiredActive,
    desiredActive,
    usage: {
      enabled: project?.usage?.enabled ?? global?.usage?.enabled ?? DEFAULT_USAGE_CONFIG.enabled,
      refreshIntervalMs: Math.max(
        15_000,
        Math.min(
          10 * 60_000,
          project?.usage?.refreshIntervalMs ??
            global?.usage?.refreshIntervalMs ??
            DEFAULT_USAGE_CONFIG.refreshIntervalMs,
        ),
      ),
      showOnlyOnSubscriptionModels:
        project?.usage?.showOnlyOnSubscriptionModels ??
        global?.usage?.showOnlyOnSubscriptionModels ??
        DEFAULT_USAGE_CONFIG.showOnlyOnSubscriptionModels,
      showResetTimes:
        project?.usage?.showResetTimes ??
        global?.usage?.showResetTimes ??
        DEFAULT_USAGE_CONFIG.showResetTimes,
    },
    footer: {
      mode: project?.footer?.mode ?? global?.footer?.mode ?? DEFAULT_FOOTER_CONFIG.mode,
    },
    image: {
      enabled: project?.image?.enabled ?? global?.image?.enabled ?? DEFAULT_IMAGE_CONFIG.enabled,
      defaultModel:
        project?.image?.defaultModel ??
        global?.image?.defaultModel ??
        DEFAULT_IMAGE_CONFIG.defaultModel,
      defaultSave:
        project?.image?.defaultSave ??
        global?.image?.defaultSave ??
        DEFAULT_IMAGE_CONFIG.defaultSave,
      outputFormat:
        project?.image?.outputFormat ??
        global?.image?.outputFormat ??
        DEFAULT_IMAGE_CONFIG.outputFormat,
      timeoutMs: Math.max(
        30_000,
        Math.min(
          5 * 60_000,
          project?.image?.timeoutMs ?? global?.image?.timeoutMs ?? DEFAULT_IMAGE_CONFIG.timeoutMs,
        ),
      ),
    },
  };
}

/** Resolves the exact document returned by an atomic commit without performing post-commit I/O. */
export function resolveCommittedConfig(
  current: ResolvedConfig,
  committed: JsonObject,
  globalFallback: JsonObject | undefined,
): ResolvedConfig {
  const metadata: ResolvedConfigMetadata = {
    configPath: current.configPath,
    projectConfigPath: current.projectConfigPath,
    globalConfigPath: current.globalConfigPath,
    projectConfigExists: current.projectConfigExists,
    globalConfigExists: current.globalConfigExists,
  };
  if (current.configPath === current.projectConfigPath) {
    return resolveConfigFiles(
      metadata,
      decodeConfig(committed),
      globalFallback === undefined ? undefined : decodeConfig(globalFallback),
    );
  }
  return resolveConfigFiles(metadata, undefined, decodeConfig(committed));
}

export const readConfig = Effect.fn("OpenAIConfig.readConfig")(function* (path: string) {
  const documents = yield* JsonDocumentStore;
  const raw = yield* documents.readObject(path).pipe(Effect.mapError(mapError("read", path)));
  return raw === undefined ? undefined : decodeConfig(raw);
});

export const writeConfig = Effect.fn("OpenAIConfig.writeConfig")(function* (
  path: string,
  config: JsonObject,
) {
  const documents = yield* JsonDocumentStore;
  yield* documents.writeObject(path, config).pipe(Effect.mapError(mapError("write", path)));
});

export const updateConfig = Effect.fn("OpenAIConfig.updateConfig")(function* (
  path: string,
  update: (document: JsonObject) => JsonObject,
) {
  const documents = yield* JsonDocumentStore;
  return yield* documents.updateObject(path, update).pipe(Effect.mapError(mapError("write", path)));
});

export const modifyConfig = Effect.fn("OpenAIConfig.modifyConfig")(function* <A, AfterCommitR>(
  path: string,
  modify: (document: JsonObject) => JsonDocumentModification<A, AfterCommitR>,
) {
  const documents = yield* JsonDocumentStore;
  const modifyObject = documents.modifyObject;
  if (modifyObject === undefined) return yield* mapError("write", path)();
  return yield* modifyObject(path, (document) =>
    Effect.try({
      try: () => modify(document),
      catch: mapError("write", path),
    }),
  ).pipe(Effect.mapError(mapError("write", path)));
});

export const resolveConfig = Effect.fn("OpenAIConfig.resolveConfig")(function* (
  cwd: string,
  agentDir: string,
  projectTrusted = true,
) {
  const paths = yield* configPaths(cwd, agentDir);
  const selected = yield* selectScopedDocument(paths).pipe(
    Effect.mapError((error) => mapError("inspect", error.path)()),
  );
  let projectExists = projectTrusted && selected.projectExists;
  let globalExists = selected.globalExists;
  if (!projectExists && !globalExists) {
    yield* writeConfig(paths.global, DEFAULT_CONFIG as JsonObject);
    globalExists = true;
  }
  const readOrWarn = (path: string) =>
    readConfig(path).pipe(
      Effect.catch(() =>
        Effect.logWarning("Unable to read a Better OpenAI configuration document.").pipe(
          Effect.as(undefined),
        ),
      ),
    );
  const project = projectExists ? yield* readOrWarn(paths.project) : undefined;
  const global = globalExists ? yield* readOrWarn(paths.global) : undefined;
  return resolveConfigFiles(
    {
      configPath: projectExists ? paths.project : paths.global,
      projectConfigPath: paths.project,
      globalConfigPath: paths.global,
      projectConfigExists: projectExists,
      globalConfigExists: globalExists,
    },
    project,
    global,
  );
});
