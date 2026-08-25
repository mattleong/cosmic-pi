import {
  DEFAULT_COMPACTION_CONFIG,
  DEFAULT_FOOTER_CONFIG,
  DEFAULT_IMAGE_CONFIG,
  DEFAULT_USAGE_CONFIG,
  type ResolvedConfig,
} from "../src/config/schema.ts";

export function makeResolvedConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    configPath: "",
    projectConfigPath: "",
    globalConfigPath: "",
    projectConfigExists: false,
    globalConfigExists: false,
    persistState: true,
    desiredActive: false,
    usage: DEFAULT_USAGE_CONFIG,
    footer: DEFAULT_FOOTER_CONFIG,
    compaction: DEFAULT_COMPACTION_CONFIG,
    image: DEFAULT_IMAGE_CONFIG,
    ...overrides,
  };
}
