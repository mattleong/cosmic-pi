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
  ADVISOR_FAST_MODE,
  ADVISOR_OPERATION_TIMEOUT_MS,
  ADVISOR_RECENT_CONTEXT_CHARS,
  ADVISOR_THINKING_LEVEL,
  AdvisorConfigError,
  DEFAULT_ADVISOR_CONFIG,
  isAdvisorConfigured,
  patchAdvisorConfig,
  ResolvedAdvisorConfigSchema,
  type AdvisorConfig,
  type AdvisorConfigPatch,
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
