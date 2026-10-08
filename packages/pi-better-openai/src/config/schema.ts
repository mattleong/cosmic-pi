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

export const DEFAULT_USAGE_CONFIG = {
  refreshIntervalMs: 60_000,
  showOnlyOnSubscriptionModels: true,
  showResetTimes: true,
} satisfies ResolvedConfig["usage"];
export const DEFAULT_COMPACTION_CONFIG = { enabled: false } satisfies ResolvedConfig["compaction"];
export const DEFAULT_IMAGE_CONFIG = {
  enabled: true,
  defaultModel: "gpt-5.5",
  defaultSave: "project",
  outputFormat: "png",
  timeoutMs: 180_000,
} satisfies ResolvedConfig["image"];
export const DEFAULT_CONFIG = {
  persistState: true,
  active: false,
  desiredActive: false,
  usage: DEFAULT_USAGE_CONFIG,
  compaction: DEFAULT_COMPACTION_CONFIG,
  image: DEFAULT_IMAGE_CONFIG,
};
