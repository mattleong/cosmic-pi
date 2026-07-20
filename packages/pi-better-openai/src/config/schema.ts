import * as Schema from "effect/Schema";

export const FOOTER_MODES = ["replace", "status", "off"] as const;
export const IMAGE_SAVE_MODES = ["none", "project", "global", "custom"] as const;
export const IMAGE_OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;

export const FooterModeSchema = Schema.Literals(FOOTER_MODES);
export const ImageSaveModeSchema = Schema.Literals(IMAGE_SAVE_MODES);
export const ImageOutputFormatSchema = Schema.Literals(IMAGE_OUTPUT_FORMATS);
const FiniteNumberSchema = Schema.Number.check(Schema.isFinite());

export const UsageConfigSchema = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  refreshIntervalMs: Schema.optional(FiniteNumberSchema),
  showOnlyOnSubscriptionModels: Schema.optional(Schema.Boolean),
  showResetTimes: Schema.optional(Schema.Boolean),
});
export const FooterConfigSchema = Schema.Struct({ mode: Schema.optional(FooterModeSchema) });
export const ImageConfigSchema = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  defaultModel: Schema.optional(Schema.String),
  defaultSave: Schema.optional(ImageSaveModeSchema),
  outputFormat: Schema.optional(ImageOutputFormatSchema),
  timeoutMs: Schema.optional(FiniteNumberSchema),
});
export const ConfigFileSchema = Schema.Struct({
  persistState: Schema.optional(Schema.Boolean),
  active: Schema.optional(Schema.Boolean),
  desiredActive: Schema.optional(Schema.Boolean),
  usage: Schema.optional(UsageConfigSchema),
  footer: Schema.optional(FooterConfigSchema),
  image: Schema.optional(ImageConfigSchema),
});

export type FooterMode = typeof FooterModeSchema.Type;
export type ImageSaveMode = typeof ImageSaveModeSchema.Type;
export type ImageOutputFormat = typeof ImageOutputFormatSchema.Type;
export type UsageConfig = typeof UsageConfigSchema.Type;
export type FooterConfig = typeof FooterConfigSchema.Type;
export type ImageConfig = typeof ImageConfigSchema.Type;
export type ConfigFile = typeof ConfigFileSchema.Type;

export interface ResolvedConfig {
  configPath: string;
  projectConfigPath: string;
  globalConfigPath: string;
  projectConfigExists: boolean;
  globalConfigExists: boolean;
  persistState: boolean;
  active: boolean;
  desiredActive: boolean;
  usage: {
    enabled: boolean;
    refreshIntervalMs: number;
    showOnlyOnSubscriptionModels: boolean;
    showResetTimes: boolean;
  };
  footer: { mode: FooterMode };
  image: {
    enabled: boolean;
    defaultModel: string;
    defaultSave: ImageSaveMode;
    outputFormat: ImageOutputFormat;
    timeoutMs: number;
  };
}

export const DEFAULT_USAGE_CONFIG: ResolvedConfig["usage"] = {
  enabled: true,
  refreshIntervalMs: 60_000,
  showOnlyOnSubscriptionModels: true,
  showResetTimes: true,
};
export const DEFAULT_FOOTER_CONFIG: ResolvedConfig["footer"] = { mode: "replace" };
export const DEFAULT_IMAGE_CONFIG: ResolvedConfig["image"] = {
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
