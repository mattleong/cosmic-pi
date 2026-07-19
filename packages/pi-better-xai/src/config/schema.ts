export const FOOTER_MODES = ["replace", "status", "off"] as const;

export type FooterMode = (typeof FOOTER_MODES)[number];

export type UsageConfig = {
  enabled?: boolean;
  refreshIntervalMs?: number;
  showOnlyOnSubscriptionModels?: boolean;
  showResetTimes?: boolean;
};

export type FooterConfig = {
  mode?: FooterMode;
};

export interface ConfigFile {
  usage?: UsageConfig;
  footer?: FooterConfig;
}

export interface ResolvedConfig {
  configPath: string;
  projectConfigPath: string;
  globalConfigPath: string;
  projectConfigExists: boolean;
  globalConfigExists: boolean;
  usage: Required<UsageConfig>;
  footer: Required<FooterConfig>;
}

export const DEFAULT_USAGE_CONFIG: Required<UsageConfig> = {
  enabled: true,
  refreshIntervalMs: 60_000,
  showOnlyOnSubscriptionModels: true,
  showResetTimes: true,
};

export const DEFAULT_FOOTER_CONFIG: Required<FooterConfig> = {
  mode: "replace",
};

export const DEFAULT_CONFIG: ConfigFile = {
  usage: DEFAULT_USAGE_CONFIG,
  footer: DEFAULT_FOOTER_CONFIG,
};
