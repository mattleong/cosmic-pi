import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as Predicate from "effect/Predicate";
import { decodeTolerantFields, type JsonObject } from "pi-cosmic-core";
import { nodeJoin } from "../boundary/node.ts";
import { snapshotDataRecord } from "../domain/safe-data.ts";
import {
  AdvisorRawFieldSchemas,
  DEFAULT_ADVISOR_CONFIG,
  type AdvisorConfigPatch,
  type ResolvedAdvisorConfig,
} from "./schema.ts";

export {
  AdvisorConfigError,
  DEFAULT_ADVISOR_CONFIG,
  ResolvedAdvisorConfigSchema,
  type AdvisorConfig,
  type AdvisorConfigPatch,
  type ResolvedAdvisorConfig,
} from "./schema.ts";

export const ADVISOR_CONFIG_BASENAME = "pi-advisor.json";
export const ADVISOR_OPERATION_TIMEOUT_MS = 90_000;
export const ADVISOR_RECENT_CONTEXT_CHARS = 120_000;
export const ADVISOR_THINKING_LEVEL: ModelThinkingLevel = "medium";
export const ADVISOR_FAST_MODE = false;

const REMOVED_CONFIG_FIELDS = [
  "mode",
  "reviewPolicy",
  "fastMode",
  "thinkingLevel",
  "timeoutMs",
  "maxContextChars",
] as const;

/** Resolve the default Advisor config path. */
export function getAdvisorConfigPath(agentDir = getAgentDir()): string {
  return nodeJoin(agentDir, "extensions", ADVISOR_CONFIG_BASENAME);
}

/** Normalize owned fields tolerantly using the resolved default path when omitted. */
export function normalizeAdvisorConfig<RawInput>(
  raw: RawInput,
  configPath = getAdvisorConfigPath(),
): ResolvedAdvisorConfig {
  const record = safeDataRecord(raw);
  const decoded = decodeTolerantFields(record, AdvisorRawFieldSchemas, {
    path: "advisor",
    maxDiagnostics: Object.keys(AdvisorRawFieldSchemas).length,
  }).value;
  const provider = nonEmptyString(decoded.provider);
  const model = nonEmptyString(decoded.model);
  const base = {
    configPath,
    enabled: decoded.enabled ?? DEFAULT_ADVISOR_CONFIG.enabled,
  };
  const withProvider = provider ? { ...base, provider } : base;
  const withModel = model ? { ...withProvider, model } : withProvider;
  return {
    ...withModel,
    setupDismissed: decoded.setupDismissed ?? DEFAULT_ADVISOR_CONFIG.setupDismissed,
    configured: Boolean(provider && model),
  };
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
  return snapshotDataRecord(value) ?? {};
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
