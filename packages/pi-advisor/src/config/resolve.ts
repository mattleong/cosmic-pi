import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import {
  decodeTolerantFields,
  JsonDocumentStore,
  type JsonDocumentModification,
  type JsonObject,
} from "pi-cosmic-core";
import { parseJson, stringifyJson } from "../boundary/json.ts";
import {
  nodeJoin,
  readTextFileOptionalSync,
  warnSyncBoundary,
  writeTextFileAtomicSync,
} from "../boundary/node.ts";
import { standaloneAdvisorExecutor } from "../boundary/executor.ts";
import { snapshotDataRecord } from "../boundary/safe-data.ts";
import { isOneOf } from "../shared/utils.ts";
export { isRecord } from "../shared/utils.ts";

export const ADVISOR_CONFIG_BASENAME = "pi-advisor.json";
export const MIN_TIMEOUT_MS = 10_000;
export const MAX_TIMEOUT_MS = 180_000;
export const MIN_CONTEXT_CHARS = 16_000;
export const MAX_CONTEXT_CHARS = 240_000;

export const ADVISOR_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ModelThinkingLevel[];
export const ADVISOR_REVIEW_POLICIES = ["corrective", "guardrail", "advisory"] as const;
export type AdvisorReviewPolicy = (typeof ADVISOR_REVIEW_POLICIES)[number];
export interface AdvisorConfig {
  enabled?: boolean | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  fastMode?: boolean | undefined;
  thinkingLevel?: ModelThinkingLevel | undefined;
  reviewPolicy?: AdvisorReviewPolicy | undefined;
  timeoutMs?: number | undefined;
  maxContextChars?: number | undefined;
}
export interface ResolvedAdvisorConfig {
  configPath: string;
  enabled: boolean;
  provider?: string | undefined;
  model?: string | undefined;
  fastMode: boolean;
  thinkingLevel: ModelThinkingLevel;
  reviewPolicy: AdvisorReviewPolicy;
  timeoutMs: number;
  maxContextChars: number;
  configured: boolean;
}
export type AdvisorConfigPatch = Partial<AdvisorConfig>;

export const AdvisorThinkingLevelSchema = Schema.Literals(ADVISOR_THINKING_LEVELS);
export const AdvisorReviewPolicySchema = Schema.Literals(ADVISOR_REVIEW_POLICIES);
export const ResolvedAdvisorConfigSchema = Schema.Struct({
  configPath: Schema.String,
  enabled: Schema.Boolean,
  provider: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  model: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  fastMode: Schema.Boolean,
  thinkingLevel: AdvisorThinkingLevelSchema,
  reviewPolicy: AdvisorReviewPolicySchema,
  timeoutMs: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: MIN_TIMEOUT_MS, maximum: MAX_TIMEOUT_MS }),
  ),
  maxContextChars: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: MIN_CONTEXT_CHARS, maximum: MAX_CONTEXT_CHARS }),
  ),
  configured: Schema.Boolean,
});

export class AdvisorConfigError extends Schema.TaggedErrorClass<AdvisorConfigError>()(
  "AdvisorConfigError",
  { operation: Schema.String, path: Schema.String, message: Schema.String },
) {}

export const DEFAULT_ADVISOR_CONFIG = {
  enabled: true,
  fastMode: true,
  thinkingLevel: "high",
  reviewPolicy: "corrective",
  timeoutMs: 90_000,
  maxContextChars: 240_000,
} as const satisfies Required<
  Pick<
    AdvisorConfig,
    "enabled" | "fastMode" | "thinkingLevel" | "reviewPolicy" | "timeoutMs" | "maxContextChars"
  >
>;

export function getAdvisorConfigPath(agentDir = getAgentDir()): string {
  return nodeJoin(agentDir, "extensions", ADVISOR_CONFIG_BASENAME);
}
export function clampTimeoutMs(value: unknown): number {
  return clampInteger(value, DEFAULT_ADVISOR_CONFIG.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
}
export function clampContextChars(value: unknown): number {
  return clampInteger(
    value,
    DEFAULT_ADVISOR_CONFIG.maxContextChars,
    MIN_CONTEXT_CHARS,
    MAX_CONTEXT_CHARS,
  );
}
export function isAdvisorConfigured(
  config: Pick<ResolvedAdvisorConfig, "provider" | "model">,
): boolean {
  return Boolean(config.provider && config.model);
}
const AdvisorRawFieldSchemas = {
  enabled: Schema.Boolean,
  provider: Schema.String,
  model: Schema.String,
  fastMode: Schema.Boolean,
  thinkingLevel: AdvisorThinkingLevelSchema,
  reviewPolicy: AdvisorReviewPolicySchema,
  timeoutMs: Schema.Number,
  maxContextChars: Schema.Number,
} as const;
const JsonObjectSchema = Schema.Record(Schema.String, Schema.Json);
const isJsonObject = (value: unknown): value is JsonObject => Schema.is(JsonObjectSchema)(value);

const normalizeAdvisorConfigData = (raw: unknown, configPath: string): ResolvedAdvisorConfig => {
  const record = migrateLegacyReviewPolicy(safeDataRecord(raw));
  const decoded = decodeTolerantFields(record, AdvisorRawFieldSchemas, {
    path: "advisor",
    maxDiagnostics: Object.keys(AdvisorRawFieldSchemas).length,
  }).value;
  const provider = nonEmptyString(decoded.provider);
  const model = nonEmptyString(decoded.model);
  return {
    configPath,
    enabled: decoded.enabled ?? DEFAULT_ADVISOR_CONFIG.enabled,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    fastMode: decoded.fastMode ?? DEFAULT_ADVISOR_CONFIG.fastMode,
    thinkingLevel: normalizeThinkingLevel(decoded.thinkingLevel),
    reviewPolicy: normalizeReviewPolicy(decoded.reviewPolicy),
    timeoutMs: clampTimeoutMs(decoded.timeoutMs),
    maxContextChars: clampContextChars(decoded.maxContextChars),
    configured: Boolean(provider && model),
  };
};

/** Schema transform/default pipeline retaining tolerant sibling recovery and legacy migration. */
export const AdvisorConfigSchema = (configPath = getAdvisorConfigPath()) =>
  Schema.Unknown.pipe(
    Schema.decodeTo(ResolvedAdvisorConfigSchema, {
      decode: SchemaGetter.transform((raw) => normalizeAdvisorConfigData(raw, configPath)),
      encode: SchemaGetter.transform((resolved) => resolved),
    }),
  );

export function normalizeAdvisorConfig(
  raw: unknown,
  configPath = getAdvisorConfigPath(),
): ResolvedAdvisorConfig {
  try {
    return Schema.decodeUnknownSync(AdvisorConfigSchema(configPath))(raw);
  } catch {
    throw new AdvisorConfigError({
      operation: "normalize",
      path: configPath,
      message: "Unable to normalize Advisor configuration.",
    });
  }
}

const mapError = (operation: string, path: string) => () =>
  new AdvisorConfigError({
    operation,
    path,
    message: `Unable to ${operation} Advisor configuration.`,
  });

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

export function patchAdvisorConfig(raw: unknown, patch: AdvisorConfigPatch): JsonObject {
  const next: JsonObject = safeDataRecord(raw);
  if ("enabled" in patch) setOptionalBoolean(next, "enabled", patch.enabled);
  if ("provider" in patch) patchOptionalString(next, "provider", patch.provider);
  if ("model" in patch) patchOptionalString(next, "model", patch.model);
  if ("fastMode" in patch) setOptionalBoolean(next, "fastMode", patch.fastMode);
  if ("thinkingLevel" in patch) {
    const value = validThinkingLevel(patch.thinkingLevel);
    if (value) next.thinkingLevel = value;
    else delete next.thinkingLevel;
  }
  if ("reviewPolicy" in patch) {
    const value = validReviewPolicy(patch.reviewPolicy);
    if (value) next.reviewPolicy = value;
    else delete next.reviewPolicy;
  }
  if ("timeoutMs" in patch) {
    if (patch.timeoutMs === undefined) delete next.timeoutMs;
    else next.timeoutMs = clampTimeoutMs(patch.timeoutMs);
  }
  if ("maxContextChars" in patch) {
    if (patch.maxContextChars === undefined) delete next.maxContextChars;
    else next.maxContextChars = clampContextChars(patch.maxContextChars);
  }
  return next;
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

function safeDataRecord(value: unknown): JsonObject {
  const snapshot = snapshotDataRecord(value);
  if (snapshot === undefined) return {};
  const decoded = Schema.decodeUnknownOption(JsonObjectSchema)(snapshot);
  return decoded._tag === "Some" ? decoded.value : {};
}
function setOptionalBoolean(target: JsonObject, key: string, value: boolean | undefined) {
  if (typeof value === "boolean") target[key] = value;
  else delete target[key];
}
function clampInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, Math.trunc(value)))
    : fallback;
}
function normalizeThinkingLevel(value: unknown): ModelThinkingLevel {
  return validThinkingLevel(value) ?? DEFAULT_ADVISOR_CONFIG.thinkingLevel;
}
function normalizeReviewPolicy(value: unknown): AdvisorReviewPolicy {
  return validReviewPolicy(value) ?? DEFAULT_ADVISOR_CONFIG.reviewPolicy;
}
function validReviewPolicy(value: unknown): AdvisorReviewPolicy | undefined {
  return isOneOf(value, ADVISOR_REVIEW_POLICIES) ? value : undefined;
}
function migrateLegacyReviewPolicy(raw: JsonObject): JsonObject {
  if (raw.reviewPolicy === "strict") return { ...raw, reviewPolicy: "corrective" };
  if (raw.reviewPolicy === "advice") return { ...raw, reviewPolicy: "advisory" };
  if (raw.reviewPolicy === "manual") return { ...raw, enabled: false, reviewPolicy: "advisory" };
  return raw;
}
function validThinkingLevel(value: unknown): ModelThinkingLevel | undefined {
  return isOneOf(value, ADVISOR_THINKING_LEVELS) ? value : undefined;
}
function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim() || undefined;
}
function patchOptionalString(
  target: JsonObject,
  key: "provider" | "model",
  value: string | undefined,
) {
  const normalized = nonEmptyString(value);
  if (normalized) target[key] = normalized;
  else delete target[key];
}
