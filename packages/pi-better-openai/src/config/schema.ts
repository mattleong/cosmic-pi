import * as Schema from "effect/Schema";

export const FOOTER_MODES = ["replace", "status", "off"] as const;
export const IMAGE_SAVE_MODES = ["none", "project", "global", "custom"] as const;
export const IMAGE_OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;

export const FooterModeSchema = Schema.Literals(FOOTER_MODES);
export const ImageSaveModeSchema = Schema.Literals(IMAGE_SAVE_MODES);
export const ImageOutputFormatSchema = Schema.Literals(IMAGE_OUTPUT_FORMATS);

export type FooterMode = typeof FooterModeSchema.Type;
export type ImageSaveMode = typeof ImageSaveModeSchema.Type;
export type ImageOutputFormat = typeof ImageOutputFormatSchema.Type;

export type UsageConfig = {
  enabled?: boolean;
  refreshIntervalMs?: number;
  showOnlyOnSubscriptionModels?: boolean;
  showResetTimes?: boolean;
};
export type FooterConfig = { mode?: FooterMode };
export type ImageConfig = {
  enabled?: boolean;
  defaultModel?: string;
  defaultSave?: ImageSaveMode;
  outputFormat?: ImageOutputFormat;
  timeoutMs?: number;
};
export interface ConfigFile {
  persistState?: boolean;
  active?: boolean;
  desiredActive?: boolean;
  usage?: UsageConfig;
  footer?: FooterConfig;
  image?: ImageConfig;
}
export interface ResolvedConfig {
  configPath: string;
  projectConfigPath: string;
  globalConfigPath: string;
  projectConfigExists: boolean;
  globalConfigExists: boolean;
  persistState: boolean;
  active: boolean;
  desiredActive: boolean;
  usage: Required<UsageConfig>;
  footer: Required<FooterConfig>;
  image: Required<ImageConfig>;
}

export const DEFAULT_USAGE_CONFIG: Required<UsageConfig> = {
  enabled: true,
  refreshIntervalMs: 60_000,
  showOnlyOnSubscriptionModels: true,
  showResetTimes: true,
};
export const DEFAULT_FOOTER_CONFIG: Required<FooterConfig> = { mode: "replace" };
export const DEFAULT_IMAGE_CONFIG: Required<ImageConfig> = {
  enabled: true,
  defaultModel: "gpt-5.5",
  defaultSave: "project",
  outputFormat: "png",
  timeoutMs: 180_000,
};
export const DEFAULT_CONFIG: ConfigFile = {
  persistState: true,
  active: false,
  desiredActive: false,
  usage: DEFAULT_USAGE_CONFIG,
  footer: DEFAULT_FOOTER_CONFIG,
  image: DEFAULT_IMAGE_CONFIG,
};
