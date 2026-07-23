import * as Schema from "effect/Schema";

export const CONFIG_BASENAME = "pi-better-openai.json";
export const FOOTER_MODES = ["replace", "status", "off"] as const;
export const IMAGE_SAVE_MODES = ["none", "project", "global", "custom"] as const;
export const IMAGE_OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;

export const FooterModeSchema = Schema.Literals(FOOTER_MODES);
export const ImageSaveModeSchema = Schema.Literals(IMAGE_SAVE_MODES);
export const ImageOutputFormatSchema = Schema.Literals(IMAGE_OUTPUT_FORMATS);

export type FooterMode = typeof FooterModeSchema.Type;
export type ImageSaveMode = typeof ImageSaveModeSchema.Type;
export type ImageOutputFormat = typeof ImageOutputFormatSchema.Type;

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
  compaction: { enabled: boolean };
  image: {
    enabled: boolean;
    defaultModel: string;
    defaultSave: ImageSaveMode;
    outputFormat: ImageOutputFormat;
    timeoutMs: number;
  };
}

type OptionalFields<T> = { readonly [K in keyof T]?: T[K] | undefined };
export type UsageConfig = OptionalFields<ResolvedConfig["usage"]>;
export type ImageConfig = OptionalFields<ResolvedConfig["image"]>;
export type ConfigFile = OptionalFields<
  Pick<ResolvedConfig, "persistState" | "active" | "desiredActive">
> & {
  readonly usage?: UsageConfig | undefined;
  readonly footer?: OptionalFields<ResolvedConfig["footer"]> | undefined;
  readonly compaction?: OptionalFields<ResolvedConfig["compaction"]> | undefined;
  readonly image?: ImageConfig | undefined;
};

export const DEFAULT_USAGE_CONFIG: ResolvedConfig["usage"] = {
  enabled: true,
  refreshIntervalMs: 60_000,
  showOnlyOnSubscriptionModels: true,
  showResetTimes: true,
};
export const DEFAULT_FOOTER_CONFIG: ResolvedConfig["footer"] = { mode: "replace" };
export const DEFAULT_COMPACTION_CONFIG: ResolvedConfig["compaction"] = { enabled: false };
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
  compaction: DEFAULT_COMPACTION_CONFIG,
  image: DEFAULT_IMAGE_CONFIG,
};
