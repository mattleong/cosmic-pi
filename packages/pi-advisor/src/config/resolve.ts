import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { JsonDocumentStore, type JsonDocumentModification, type JsonObject } from "pi-cosmic-core";
import { parseJson, stringifyJson } from "../boundary/json.ts";
import {
  nodeJoin,
  readTextFileOptionalSync,
  warnSyncBoundary,
  writeTextFileAtomicSync,
} from "../boundary/node.ts";
import { standaloneAdvisorExecutor } from "../boundary/executor.ts";
import {
  AdvisorConfigError,
  AdvisorConfigSchema as SchemaAdvisorConfigSchema,
  migrateLegacyReviewPolicy,
  normalizeAdvisorConfig as normalizeAdvisorConfigAtPath,
  patchAdvisorConfig,
  type AdvisorConfigPatch,
  type ResolvedAdvisorConfig,
  ADVISOR_CONFIG_BASENAME,
} from "./schema.ts";

export { isRecord } from "../shared/utils.ts";
export {
  ADVISOR_CONFIG_BASENAME,
  ADVISOR_REVIEW_POLICIES,
  ADVISOR_THINKING_LEVELS,
  AdvisorConfigError,
  AdvisorReviewPolicySchema,
  AdvisorThinkingLevelSchema,
  clampContextChars,
  clampTimeoutMs,
  DEFAULT_ADVISOR_CONFIG,
  isAdvisorConfigured,
  MAX_CONTEXT_CHARS,
  MAX_TIMEOUT_MS,
  MIN_CONTEXT_CHARS,
  MIN_TIMEOUT_MS,
  patchAdvisorConfig,
  ResolvedAdvisorConfigSchema,
  type AdvisorConfig,
  type AdvisorConfigPatch,
  type AdvisorReviewPolicy,
  type ResolvedAdvisorConfig,
} from "./schema.ts";

/** Schema transform with default config path when omitted. */
export const AdvisorConfigSchema = (configPath = getAdvisorConfigPath()) =>
  SchemaAdvisorConfigSchema(configPath);

export function getAdvisorConfigPath(agentDir = getAgentDir()): string {
  return nodeJoin(agentDir, "extensions", ADVISOR_CONFIG_BASENAME);
}

/** Normalize raw config using the default path when omitted. */
export function normalizeAdvisorConfig(
  raw: unknown,
  configPath = getAdvisorConfigPath(),
): ResolvedAdvisorConfig {
  return normalizeAdvisorConfigAtPath(raw, configPath);
}

const mapError = (operation: string, path: string) => () =>
  new AdvisorConfigError({
    operation,
    path,
    message: `Unable to ${operation} Advisor configuration.`,
  });

const JsonObjectSchema = Schema.Record(Schema.String, Schema.Json);
const isJsonObject = (value: unknown): value is JsonObject => Schema.is(JsonObjectSchema)(value);

export const readRawAdvisorConfigEffect = Effect.fn("AdvisorConfig.readRaw")(function* (
  path = getAdvisorConfigPath(),
) {
  const documents = yield* JsonDocumentStore;
  return yield* documents.readObject(path).pipe(
    Effect.map((value) => value ?? {}),
    Effect.catch((error) =>
      Effect.logWarning(`Advisor config read failed (${error.operation}).`).pipe(
        Effect.as({} as JsonObject),
      ),
    ),
  );
});

export function readRawAdvisorConfig(path = getAdvisorConfigPath()): JsonObject {
  const source = readTextFileOptionalSync(path);
  if (source === undefined) return {};
  try {
    const decoded = parseJson(source);
    if (isJsonObject(decoded)) return decoded;
  } catch {
    // Report malformed existing files while keeping reads fail-open.
  }
  warnSyncBoundary(`Advisor config read failed at ${path}.`);
  return {};
}

export function readRawAdvisorConfigAsync(path = getAdvisorConfigPath()): Promise<JsonObject> {
  return standaloneAdvisorExecutor.run(readRawAdvisorConfigEffect(path));
}

export const loadAdvisorConfigEffect = Effect.fn("AdvisorConfig.load")(function* (
  path = getAdvisorConfigPath(),
) {
  return normalizeAdvisorConfig(yield* readRawAdvisorConfigEffect(path), path);
});

export function loadAdvisorConfig(path = getAdvisorConfigPath()): ResolvedAdvisorConfig {
  return normalizeAdvisorConfig(readRawAdvisorConfig(path), path);
}

export function loadAdvisorConfigAsync(
  path = getAdvisorConfigPath(),
): Promise<ResolvedAdvisorConfig> {
  return standaloneAdvisorExecutor.run(loadAdvisorConfigEffect(path));
}

const protectAdvisorConfigDirectoryEffect = Effect.fn("AdvisorConfig.protectDirectory")(function* (
  path: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const directory = paths.dirname(path);
  const existed = yield* fs.exists(directory);
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  if (!existed || paths.basename(directory) === "extensions") {
    yield* fs.chmod(directory, 0o700);
  }
});

export const writeRawAdvisorConfigEffect = Effect.fn("AdvisorConfig.writeRaw")(function* (
  raw: JsonObject,
  path = getAdvisorConfigPath(),
) {
  const documents = yield* JsonDocumentStore;
  yield* protectAdvisorConfigDirectoryEffect(path).pipe(
    Effect.mapError(mapError("protect directory", path)),
  );
  yield* documents.writeObject(path, raw).pipe(Effect.mapError(mapError("write", path)));
});

export function writeRawAdvisorConfig(raw: JsonObject, path = getAdvisorConfigPath()): void {
  writeTextFileAtomicSync(path, `${stringifyJson(raw)}\n`);
}

export function writeRawAdvisorConfigAsync(
  raw: JsonObject,
  path = getAdvisorConfigPath(),
): Promise<void> {
  return standaloneAdvisorExecutor.run(writeRawAdvisorConfigEffect(raw, path));
}

export const writeAdvisorConfigPatchEffect = Effect.fn("AdvisorConfig.patch")(function* <
  AfterCommitR = never,
>(
  patch: AdvisorConfigPatch,
  path = getAdvisorConfigPath(),
  afterCommit?: (next: ResolvedAdvisorConfig) => Effect.Effect<void, never, AfterCommitR>,
) {
  const documents = yield* JsonDocumentStore;
  yield* protectAdvisorConfigDirectoryEffect(path).pipe(
    Effect.mapError(mapError("protect directory", path)),
  );
  const modifyObject = documents.modifyObject;
  if (modifyObject) {
    return yield* modifyObject(path, (raw) =>
      Effect.try({
        try: () => {
          const document = patchAdvisorConfig(migrateLegacyReviewPolicy(raw), patch);
          const next = normalizeAdvisorConfig(document, path);
          return {
            value: next,
            document,
            ...(afterCommit ? { afterCommit: afterCommit(next) } : {}),
          } satisfies JsonDocumentModification<ResolvedAdvisorConfig, AfterCommitR>;
        },
        catch: mapError("update", path),
      }),
    ).pipe(Effect.mapError(mapError("update", path)));
  }
  if (afterCommit)
    return yield* new AdvisorConfigError({
      operation: "update",
      path,
      message: "Unable to commit Advisor configuration state atomically.",
    });
  let next: JsonObject | undefined;
  yield* documents
    .updateObject(path, (raw) => {
      next = patchAdvisorConfig(migrateLegacyReviewPolicy(raw), patch);
      return next;
    })
    .pipe(Effect.mapError(mapError("update", path)));
  return normalizeAdvisorConfig(next ?? {}, path);
});

export function writeAdvisorConfigPatch(
  patch: AdvisorConfigPatch,
  path = getAdvisorConfigPath(),
): ResolvedAdvisorConfig {
  const source = readTextFileOptionalSync(path);
  let raw: JsonObject = {};
  if (source !== undefined) {
    const decoded = parseJson(source);
    if (!isJsonObject(decoded))
      throw new AdvisorConfigError({
        operation: "update",
        path,
        message: "Unable to update Advisor configuration.",
      });
    raw = decoded;
  }
  const next = patchAdvisorConfig(migrateLegacyReviewPolicy(raw), patch);
  writeRawAdvisorConfig(next, path);
  return normalizeAdvisorConfig(next, path);
}

export function writeAdvisorConfigPatchAsync(
  patch: AdvisorConfigPatch,
  path = getAdvisorConfigPath(),
): Promise<ResolvedAdvisorConfig> {
  return standaloneAdvisorExecutor.run(writeAdvisorConfigPatchEffect(patch, path));
}
