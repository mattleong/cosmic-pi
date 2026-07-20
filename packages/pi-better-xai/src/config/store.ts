import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { JsonDocumentStore, type JsonObject } from "pi-cosmic-core";
import { CONFIG_BASENAME } from "../identity.ts";
import {
  FooterModeSchema,
  DEFAULT_CONFIG,
  DEFAULT_FOOTER_CONFIG,
  DEFAULT_USAGE_CONFIG,
  type ResolvedConfig,
} from "./schema.ts";
import { isRecord } from "../utils.ts";

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
  const path = yield* Path.Path;
  return {
    project: path.join(cwd, CONFIG_DIR_NAME, "extensions", CONFIG_BASENAME),
    global: path.join(agentDir, "extensions", CONFIG_BASENAME),
  } as const;
});

export const readRawConfig = Effect.fn("XaiConfig.readRawConfig")(function* (path: string) {
  const documents = yield* JsonDocumentStore;
  return yield* documents.readObject(path).pipe(
    Effect.mapError(mapDocumentError("read", path)),
    Effect.map((value) => value ?? {}),
  );
});

function decodeConfig(value: unknown) {
  if (!isRecord(value)) return {};
  const usageRaw = isRecord(value.usage) ? value.usage : undefined;
  const footerRaw = isRecord(value.footer) ? value.footer : undefined;
  const enabled = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.Boolean)(usageRaw?.enabled),
  );
  const refreshInterval = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.Number)(usageRaw?.refreshIntervalMs),
  );
  const showOnly = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.Boolean)(usageRaw?.showOnlyOnSubscriptionModels),
  );
  const showResets = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.Boolean)(usageRaw?.showResetTimes),
  );
  const footerMode = Option.getOrUndefined(
    Schema.decodeUnknownOption(FooterModeSchema)(footerRaw?.mode),
  );
  const usage = {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(refreshInterval !== undefined && Number.isFinite(refreshInterval)
      ? { refreshIntervalMs: refreshInterval }
      : {}),
    ...(showOnly !== undefined ? { showOnlyOnSubscriptionModels: showOnly } : {}),
    ...(showResets !== undefined ? { showResetTimes: showResets } : {}),
  };
  return {
    ...(Object.keys(usage).length > 0 ? { usage } : {}),
    ...(footerMode !== undefined ? { footer: { mode: footerMode } } : {}),
  };
}

export const readConfig = Effect.fn("XaiConfig.readConfig")(function* (path: string) {
  const documents = yield* JsonDocumentStore;
  const raw = yield* documents
    .readObject(path)
    .pipe(Effect.mapError(mapDocumentError("read", path)));
  return raw === undefined ? undefined : decodeConfig(raw);
});

export const writeConfig = Effect.fn("XaiConfig.writeConfig")(function* (
  path: string,
  config: JsonObject,
) {
  const documents = yield* JsonDocumentStore;
  yield* documents.writeObject(path, config).pipe(Effect.mapError(mapDocumentError("write", path)));
});

const defaultDocument = (): JsonObject => ({
  usage: { ...DEFAULT_CONFIG.usage },
  footer: { ...DEFAULT_CONFIG.footer },
});

export const resolveConfig = Effect.fn("XaiConfig.resolveConfig")(function* (
  cwd: string,
  agentDir: string,
) {
  const documents = yield* JsonDocumentStore;
  const paths = yield* configPaths(cwd, agentDir);
  let projectExists = yield* documents
    .exists(paths.project)
    .pipe(Effect.mapError(mapDocumentError("inspect", paths.project)));
  let globalExists = yield* documents
    .exists(paths.global)
    .pipe(Effect.mapError(mapDocumentError("inspect", paths.global)));

  if (!projectExists && !globalExists) {
    yield* writeConfig(paths.global, defaultDocument());
    globalExists = true;
  }

  const readOrDefault = (path: string, exists: boolean) =>
    exists ? readConfig(path).pipe(Effect.catch(() => Effect.void)) : Effect.void;
  const project = yield* readOrDefault(paths.project, projectExists);
  const global = yield* readOrDefault(paths.global, globalExists);
  const usage = {
    enabled: project?.usage?.enabled ?? global?.usage?.enabled ?? DEFAULT_USAGE_CONFIG.enabled,
    refreshIntervalMs:
      project?.usage?.refreshIntervalMs ??
      global?.usage?.refreshIntervalMs ??
      DEFAULT_USAGE_CONFIG.refreshIntervalMs,
    showOnlyOnSubscriptionModels:
      project?.usage?.showOnlyOnSubscriptionModels ??
      global?.usage?.showOnlyOnSubscriptionModels ??
      DEFAULT_USAGE_CONFIG.showOnlyOnSubscriptionModels,
    showResetTimes:
      project?.usage?.showResetTimes ??
      global?.usage?.showResetTimes ??
      DEFAULT_USAGE_CONFIG.showResetTimes,
  };
  const footer = {
    mode: project?.footer?.mode ?? global?.footer?.mode ?? DEFAULT_FOOTER_CONFIG.mode,
  };

  return {
    configPath: projectExists ? paths.project : paths.global,
    projectConfigPath: paths.project,
    globalConfigPath: paths.global,
    projectConfigExists: projectExists,
    globalConfigExists: globalExists,
    usage: {
      enabled: usage.enabled,
      refreshIntervalMs: Math.max(5_000, usage.refreshIntervalMs),
      showOnlyOnSubscriptionModels: usage.showOnlyOnSubscriptionModels,
      showResetTimes: usage.showResetTimes,
    },
    footer: { mode: footer.mode },
  } satisfies ResolvedConfig;
});
