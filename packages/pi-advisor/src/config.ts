import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isRecord } from "./utils.ts";
export { isRecord } from "./utils.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export const ADVISOR_CONFIG_BASENAME = "pi-advisor.json";

export const MIN_TIMEOUT_MS = 10_000;
export const MAX_TIMEOUT_MS = 180_000;
export const MIN_CONTEXT_CHARS = 16_000;
export const MAX_CONTEXT_CHARS = 240_000;

export type AdvisorReviewPolicy = "corrective" | "guardrail" | "advisory";

export interface AdvisorConfig {
  enabled?: boolean;
  provider?: string;
  model?: string;
  fastMode?: boolean;
  thinkingLevel?: ModelThinkingLevel;
  reviewPolicy?: AdvisorReviewPolicy;
  timeoutMs?: number;
  maxContextChars?: number;
}

export interface ResolvedAdvisorConfig {
  configPath: string;
  enabled: boolean;
  provider?: string;
  model?: string;
  fastMode: boolean;
  thinkingLevel: ModelThinkingLevel;
  reviewPolicy: AdvisorReviewPolicy;
  timeoutMs: number;
  maxContextChars: number;
  configured: boolean;
}

export type AdvisorConfigPatch = Partial<AdvisorConfig>;

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
  return join(agentDir, "extensions", ADVISOR_CONFIG_BASENAME);
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

export function normalizeAdvisorConfig(
  raw: unknown,
  configPath = getAdvisorConfigPath(),
): ResolvedAdvisorConfig {
  const record = migrateLegacyReviewPolicy(isRecord(raw) ? raw : {});
  const provider = nonEmptyString(record.provider);
  const model = nonEmptyString(record.model);
  const normalized: ResolvedAdvisorConfig = {
    configPath,
    enabled: typeof record.enabled === "boolean" ? record.enabled : DEFAULT_ADVISOR_CONFIG.enabled,
    fastMode:
      typeof record.fastMode === "boolean" ? record.fastMode : DEFAULT_ADVISOR_CONFIG.fastMode,
    thinkingLevel: normalizeThinkingLevel(record.thinkingLevel),
    reviewPolicy: normalizeReviewPolicy(record.reviewPolicy),
    timeoutMs: clampTimeoutMs(record.timeoutMs),
    maxContextChars: clampContextChars(record.maxContextChars),
    configured: Boolean(provider && model),
  };
  if (provider) normalized.provider = provider;
  if (model) normalized.model = model;
  return normalized;
}

export function readRawAdvisorConfig(path = getAdvisorConfigPath()): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function loadAdvisorConfig(path = getAdvisorConfigPath()): ResolvedAdvisorConfig {
  return normalizeAdvisorConfig(readRawAdvisorConfig(path), path);
}

export function patchAdvisorConfig(
  raw: unknown,
  patch: AdvisorConfigPatch,
): Record<string, unknown> {
  const next: Record<string, unknown> = isRecord(raw) ? { ...raw } : {};

  if ("enabled" in patch) {
    if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
    else delete next.enabled;
  }
  if ("provider" in patch) patchOptionalString(next, "provider", patch.provider);
  if ("model" in patch) patchOptionalString(next, "model", patch.model);
  if ("fastMode" in patch) {
    if (typeof patch.fastMode === "boolean") next.fastMode = patch.fastMode;
    else delete next.fastMode;
  }
  if ("thinkingLevel" in patch) {
    const thinkingLevel = validThinkingLevel(patch.thinkingLevel);
    if (thinkingLevel) next.thinkingLevel = thinkingLevel;
    else delete next.thinkingLevel;
  }
  if ("reviewPolicy" in patch) {
    const reviewPolicy = validReviewPolicy(patch.reviewPolicy);
    if (reviewPolicy) next.reviewPolicy = reviewPolicy;
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

export function writeRawAdvisorConfig(
  raw: Record<string, unknown>,
  path = getAdvisorConfigPath(),
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}

export function writeAdvisorConfigPatch(
  patch: AdvisorConfigPatch,
  path = getAdvisorConfigPath(),
): ResolvedAdvisorConfig {
  const raw = migrateLegacyReviewPolicy(readRawAdvisorConfig(path));
  const next = patchAdvisorConfig(raw, patch);
  writeRawAdvisorConfig(next, path);
  return normalizeAdvisorConfig(next, path);
}

function clampInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

function normalizeThinkingLevel(value: unknown): ModelThinkingLevel {
  return validThinkingLevel(value) ?? DEFAULT_ADVISOR_CONFIG.thinkingLevel;
}

function normalizeReviewPolicy(value: unknown): AdvisorReviewPolicy {
  return validReviewPolicy(value) ?? DEFAULT_ADVISOR_CONFIG.reviewPolicy;
}

function validReviewPolicy(value: unknown): AdvisorReviewPolicy | undefined {
  switch (value) {
    case "corrective":
    case "guardrail":
    case "advisory":
      return value;
    default:
      return undefined;
  }
}

function migrateLegacyReviewPolicy(raw: Record<string, unknown>): Record<string, unknown> {
  if (raw.reviewPolicy === "strict") return { ...raw, reviewPolicy: "corrective" };
  if (raw.reviewPolicy === "advice") return { ...raw, reviewPolicy: "advisory" };
  if (raw.reviewPolicy === "manual") {
    return { ...raw, enabled: false, reviewPolicy: "advisory" };
  }
  return raw;
}

function validThinkingLevel(value: unknown): ModelThinkingLevel | undefined {
  switch (value) {
    case "off":
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return value;
    default:
      return undefined;
  }
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function patchOptionalString(
  target: Record<string, unknown>,
  key: "provider" | "model",
  value: string | undefined,
): void {
  const normalized = nonEmptyString(value);
  if (normalized) target[key] = normalized;
  else delete target[key];
}
