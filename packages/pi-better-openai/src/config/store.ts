import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Number from "effect/Number";
import * as Schema from "effect/Schema";
import {
  decodeTolerantFields,
  makeConfigDocumentErrorFactory,
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
import {
  CONFIG_BASENAME,
  DEFAULT_COMPACTION_CONFIG,
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

const mapError = makeConfigDocumentErrorFactory(OpenAIConfigError, "Better OpenAI");

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
  return yield* readRawJsonObject(path, mapError);
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
      compaction: UnknownRecordSchema,
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
  const compaction = decodeTolerantFields(
    root.compaction,
    { enabled: Schema.Boolean },
    { path: "compaction" },
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
    ...(compaction.enabled !== undefined ? { compaction: { enabled: compaction.enabled } } : {}),
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
      refreshIntervalMs: Number.clamp(
        project?.usage?.refreshIntervalMs ??
          global?.usage?.refreshIntervalMs ??
          DEFAULT_USAGE_CONFIG.refreshIntervalMs,
        { minimum: 15_000, maximum: 10 * 60_000 },
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
    compaction: {
      enabled:
        project?.compaction?.enabled ??
        global?.compaction?.enabled ??
        DEFAULT_COMPACTION_CONFIG.enabled,
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
      timeoutMs: Number.clamp(
        project?.image?.timeoutMs ?? global?.image?.timeoutMs ?? DEFAULT_IMAGE_CONFIG.timeoutMs,
        { minimum: 30_000, maximum: 5 * 60_000 },
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
  return yield* readOptionalJsonObject(path, decodeConfig, mapError);
});

export const writeConfig = Effect.fn("OpenAIConfig.writeConfig")(function* (
  path: string,
  config: JsonObject,
) {
  yield* writeJsonObject(path, config, mapError);
});

export const modifyConfig = Effect.fn("OpenAIConfig.modifyConfig")(function* <A, AfterCommitR>(
  path: string,
  modify: (document: JsonObject) => JsonDocumentModification<A, AfterCommitR>,
) {
  return yield* modifyJsonObject(path, modify, mapError);
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
  const warning = "Unable to read a Better OpenAI configuration document.";
  const [project, global] = yield* Effect.all(
    [
      readConfigOrWarn(paths.project, projectExists, readConfig, warning),
      readConfigOrWarn(paths.global, globalExists, readConfig, warning),
    ] as const,
    { concurrency: 2 },
  );
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
