import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { nodeJoin } from "../boundary/node.ts";
import {
  AdvisorConfigSchema as SchemaAdvisorConfigSchema,
  normalizeAdvisorConfig as normalizeAdvisorConfigAtPath,
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

/** Resolve the default Advisor config path. */
export function getAdvisorConfigPath(agentDir = getAgentDir()): string {
  return nodeJoin(agentDir, "extensions", ADVISOR_CONFIG_BASENAME);
}

/** Schema transform with the resolved default config path when omitted. */
export const AdvisorConfigSchema = (configPath = getAdvisorConfigPath()) =>
  SchemaAdvisorConfigSchema(configPath);

/** Normalize raw config using the resolved default path when omitted. */
export function normalizeAdvisorConfig(
  raw: unknown,
  configPath = getAdvisorConfigPath(),
): ResolvedAdvisorConfig {
  return normalizeAdvisorConfigAtPath(raw, configPath);
}
