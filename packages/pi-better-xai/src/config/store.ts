import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  decodeTolerantFields,
  JsonDocumentStore,
  scopedDocumentPaths,
  selectScopedDocument,
  type JsonObject,
} from "pi-cosmic-core";
import { CONFIG_BASENAME } from "../identity.ts";
import {
  FooterModeSchema,
  DEFAULT_CONFIG,
  DEFAULT_FOOTER_CONFIG,
  DEFAULT_USAGE_CONFIG,
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
  const documents = yield* JsonDocumentStore;
  return yield* documents.readObject(path).pipe(
    Effect.mapError(mapDocumentError("read", path)),
    Effect.map((value) => value ?? {}),
  );
});

const UnknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
const FiniteNumberSchema = Schema.Number.check(Schema.isFinite());

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

  const readOrDefault = (path: string, exists: boolean) =>
    exists
      ? readConfig(path).pipe(
          Effect.catch(() =>
            Effect.logWarning("Unable to read a Better xAI configuration document.").pipe(
              Effect.asVoid,
            ),
          ),
        )
      : Effect.void;
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
