import * as Predicate from "effect/Predicate";

import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import { decodeTolerantFields, type JsonObject } from "pi-cosmic-core";
import { snapshotDataRecord } from "../domain/safe-data.ts";

export const ADVISOR_CONFIG_BASENAME = "pi-advisor.json";
export const ADVISOR_OPERATION_TIMEOUT_MS = 90_000;
export const ADVISOR_RECENT_CONTEXT_CHARS = 120_000;
export const ADVISOR_THINKING_LEVEL: ModelThinkingLevel = "medium";
export const ADVISOR_FAST_MODE = false;

export interface AdvisorConfig {
  enabled?: boolean | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  setupDismissed?: boolean | undefined;
}

export interface ResolvedAdvisorConfig {
  configPath: string;
  enabled: boolean;
  provider?: string | undefined;
  model?: string | undefined;
  setupDismissed: boolean;
  configured: boolean;
}

export type AdvisorConfigPatch = Partial<AdvisorConfig>;
export const ResolvedAdvisorConfigSchema = Schema.Struct({
  configPath: Schema.String,
  enabled: Schema.Boolean,
  provider: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  model: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  setupDismissed: Schema.Boolean,
  configured: Schema.Boolean,
});

export class AdvisorConfigError extends Schema.TaggedError<AdvisorConfigError>()(
  "AdvisorConfigError",
  { operation: Schema.String, path: Schema.String, message: Schema.String },
) {}

export const DEFAULT_ADVISOR_CONFIG = {
  enabled: false,
  setupDismissed: false,
} as const satisfies Required<Pick<AdvisorConfig, "enabled" | "setupDismissed">>;

export function isAdvisorConfigured(
  config: Pick<ResolvedAdvisorConfig, "provider" | "model">,
): boolean {
  return Boolean(config.provider && config.model);
}

const AdvisorRawFieldSchemas = {
  enabled: Schema.Boolean,
  provider: Schema.String,
  model: Schema.String,
  setupDismissed: Schema.Boolean,
} as const;
const JsonObjectSchema = Schema.Record(Schema.String, Schema.MutableJson);
const REMOVED_CONFIG_FIELDS = [
  "mode",
  "reviewPolicy",
  "fastMode",
  "thinkingLevel",
  "timeoutMs",
  "maxContextChars",
] as const;

const normalizeAdvisorConfigData = <Raw>(raw: Raw, configPath: string): ResolvedAdvisorConfig => {
  const record = safeDataRecord(raw);
  const decoded = decodeTolerantFields(record, AdvisorRawFieldSchemas, {
    path: "advisor",
    maxDiagnostics: Object.keys(AdvisorRawFieldSchemas).length,
  }).value;
  const provider = nonEmptyString(decoded.provider);
  const model = nonEmptyString(decoded.model);
  return (() => {
    const objectPart2673_0 = {
      configPath,
      enabled: decoded.enabled ?? DEFAULT_ADVISOR_CONFIG.enabled,
    };
    const objectPart2673_1 = provider ? { ...objectPart2673_0, provider } : objectPart2673_0;
    const objectPart2673_2 = model ? { ...objectPart2673_1, model } : objectPart2673_1;
    const objectPart2673_3 = {
      ...objectPart2673_2,
      setupDismissed: decoded.setupDismissed ?? DEFAULT_ADVISOR_CONFIG.setupDismissed,
      configured: Boolean(provider && model),
    };
    return objectPart2673_3;
  })();
};

export const AdvisorConfigSchema = (configPath: string) =>
  Schema.Unknown.pipe(
    Schema.decodeTo(ResolvedAdvisorConfigSchema, {
      decode: SchemaGetter.transform((raw) => normalizeAdvisorConfigData(raw, configPath)),
      encode: SchemaGetter.transform((resolved) => resolved),
    }),
  );

export function normalizeAdvisorConfig<RawInput>(
  raw: RawInput,
  configPath: string,
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

/** Patch only the current persisted contract while preserving unrelated root fields. */
export function patchAdvisorConfig<RawInput>(raw: RawInput, patch: AdvisorConfigPatch): JsonObject {
  const next: JsonObject = safeDataRecord(raw);
  for (const field of REMOVED_CONFIG_FIELDS) delete next[field];
  if ("enabled" in patch) setOptionalBoolean(next, "enabled", patch.enabled);
  if ("provider" in patch) patchOptionalString(next, "provider", patch.provider);
  if ("model" in patch) patchOptionalString(next, "model", patch.model);
  if ("setupDismissed" in patch) setOptionalBoolean(next, "setupDismissed", patch.setupDismissed);
  return next;
}

function safeDataRecord<ValueInput>(value: ValueInput): JsonObject {
  const snapshot = snapshotDataRecord(value);
  if (snapshot === undefined) return {};
  const decoded = Schema.decodeUnknownOption(JsonObjectSchema)(snapshot);
  return decoded._tag === "Some" ? decoded.value : {};
}
function setOptionalBoolean(target: JsonObject, key: string, value: boolean | undefined) {
  if (Predicate.isBoolean(value)) target[key] = value;
  else delete target[key];
}
function nonEmptyString<ValueInput>(value: ValueInput): string | undefined {
  if (!Predicate.isString(value)) return undefined;
  return value.trim() || undefined;
}
function patchOptionalString(target: JsonObject, key: "provider" | "model", value?: string) {
  const normalized = nonEmptyString(value);
  if (normalized) target[key] = normalized;
  else delete target[key];
}
