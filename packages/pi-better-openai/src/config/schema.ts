import * as Schema from "effect/Schema";
import type { ScopedConfigMetadata, SubscriptionUsageConfig } from "pi-cosmic-core";

export const CONFIG_BASENAME = "pi-better-openai.json";
export const IMAGE_SAVE_MODES = ["none", "project", "global", "custom"] as const;
export const IMAGE_OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;

export const ImageSaveModeSchema = Schema.Literals(IMAGE_SAVE_MODES);
export const ImageOutputFormatSchema = Schema.Literals(IMAGE_OUTPUT_FORMATS);

export type ImageSaveMode = typeof ImageSaveModeSchema.Type;
export type ImageOutputFormat = typeof ImageOutputFormatSchema.Type;

export interface ResolvedConfig extends ScopedConfigMetadata {
  persistState: boolean;
  desiredActive: boolean;
  usage: SubscriptionUsageConfig;
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
export type ConfigFile = OptionalFields<Pick<ResolvedConfig, "persistState" | "desiredActive">> & {
  /** Legacy fast-mode state retained for tolerant reads and compatibility writes. */
  readonly active?: boolean | undefined;
  readonly usage?: UsageConfig | undefined;
  readonly compaction?: OptionalFields<ResolvedConfig["compaction"]> | undefined;
  readonly image?: ImageConfig | undefined;
};

export const DEFAULT_USAGE_CONFIG: ResolvedConfig["usage"] = {
  refreshIntervalMs: 60_000,
  showOnlyOnSubscriptionModels: true,
  showResetTimes: true,
};
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
  compaction: DEFAULT_COMPACTION_CONFIG,
  image: DEFAULT_IMAGE_CONFIG,
};
