import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { JsonDocumentStore, type JsonObject } from "pi-cosmic-core";
import { CONFIG_BASENAME } from "../identity.ts";
import { isRecord } from "../utils.ts";
import {
  DEFAULT_CONFIG,
  DEFAULT_FOOTER_CONFIG,
  DEFAULT_IMAGE_CONFIG,
  DEFAULT_USAGE_CONFIG,
  FooterModeSchema,
  ImageOutputFormatSchema,
  ImageSaveModeSchema,
  type ConfigFile,
  type ResolvedConfig,
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
  const path = yield* Path.Path;
  return {
    project: path.join(cwd, CONFIG_DIR_NAME, "extensions", CONFIG_BASENAME),
    global: path.join(agentDir, "extensions", CONFIG_BASENAME),
  } as const;
});

export const readRawConfig = Effect.fn("OpenAIConfig.readRawConfig")(function* (path: string) {
  const documents = yield* JsonDocumentStore;
  return yield* documents.readObject(path).pipe(
    Effect.mapError(mapError("read", path)),
    Effect.map((value) => value ?? {}),
  );
});

const decodeBoolean = (value: unknown) =>
  Option.getOrUndefined(Schema.decodeUnknownOption(Schema.Boolean)(value));
const decodeNumber = (value: unknown) =>
  Option.getOrUndefined(Schema.decodeUnknownOption(Schema.Number)(value));
const decodeString = (value: unknown) =>
  Option.getOrUndefined(Schema.decodeUnknownOption(Schema.String)(value));

function decodeConfig(value: unknown): ConfigFile {
  if (!isRecord(value)) return {};
  const usageRaw = isRecord(value.usage) ? value.usage : undefined;
  const footerRaw = isRecord(value.footer) ? value.footer : undefined;
  const imageRaw = isRecord(value.image) ? value.image : undefined;
  const usage: UsageConfigShape = {
    enabled: decodeBoolean(usageRaw?.enabled),
    refreshIntervalMs: decodeNumber(usageRaw?.refreshIntervalMs),
    showOnlyOnSubscriptionModels: decodeBoolean(usageRaw?.showOnlyOnSubscriptionModels),
    showResetTimes: decodeBoolean(usageRaw?.showResetTimes),
  };
  const footerMode = Option.getOrUndefined(
    Schema.decodeUnknownOption(FooterModeSchema)(footerRaw?.mode),
  );
  const defaultModel = decodeString(imageRaw?.defaultModel)?.trim();
  const image: ImageConfigShape = {
    enabled: decodeBoolean(imageRaw?.enabled),
    defaultModel: defaultModel || undefined,
    defaultSave: Option.getOrUndefined(
      Schema.decodeUnknownOption(ImageSaveModeSchema)(imageRaw?.defaultSave),
    ),
    outputFormat: Option.getOrUndefined(
      Schema.decodeUnknownOption(ImageOutputFormatSchema)(imageRaw?.outputFormat),
    ),
    timeoutMs: decodeNumber(imageRaw?.timeoutMs),
  };
  const compact = <A extends Record<string, unknown>>(record: A) =>
    Object.fromEntries(Object.entries(record).filter(([, field]) => field !== undefined));
  const compactUsage = compact(usage);
  const compactImage = compact(image);
  return {
    ...compact({
      persistState: decodeBoolean(value.persistState),
      active: decodeBoolean(value.active),
      desiredActive: decodeBoolean(value.desiredActive),
    }),
    ...(Object.keys(compactUsage).length ? { usage: compactUsage } : {}),
    ...(footerMode ? { footer: { mode: footerMode } } : {}),
    ...(Object.keys(compactImage).length ? { image: compactImage } : {}),
  } as ConfigFile;
}

type UsageConfigShape = {
  enabled?: boolean | undefined;
  refreshIntervalMs?: number | undefined;
  showOnlyOnSubscriptionModels?: boolean | undefined;
  showResetTimes?: boolean | undefined;
};
type ImageConfigShape = {
  enabled?: boolean | undefined;
  defaultModel?: string | undefined;
  defaultSave?: typeof ImageSaveModeSchema.Type | undefined;
  outputFormat?: typeof ImageOutputFormatSchema.Type | undefined;
  timeoutMs?: number | undefined;
};

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

export const resolveConfig = Effect.fn("OpenAIConfig.resolveConfig")(function* (
  cwd: string,
  agentDir = getAgentDir(),
) {
  const documents = yield* JsonDocumentStore;
  const paths = yield* configPaths(cwd, agentDir);
  let projectExists = yield* documents
    .exists(paths.project)
    .pipe(Effect.mapError(mapError("inspect", paths.project)));
  let globalExists = yield* documents
    .exists(paths.global)
    .pipe(Effect.mapError(mapError("inspect", paths.global)));
  if (!projectExists && !globalExists) {
    yield* writeConfig(paths.global, DEFAULT_CONFIG as JsonObject);
    globalExists = true;
  }
  const project = projectExists
    ? yield* readConfig(paths.project).pipe(Effect.catch(() => Effect.void))
    : undefined;
  const global = globalExists
    ? yield* readConfig(paths.global).pipe(Effect.catch(() => Effect.void))
    : undefined;
  const desiredActive =
    project?.desiredActive ??
    project?.active ??
    global?.desiredActive ??
    global?.active ??
    DEFAULT_CONFIG.desiredActive ??
    false;
  return {
    configPath: projectExists ? paths.project : paths.global,
    projectConfigPath: paths.project,
    globalConfigPath: paths.global,
    projectConfigExists: projectExists,
    globalConfigExists: globalExists,
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
  } satisfies ResolvedConfig;
});
