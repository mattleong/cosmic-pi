export const FOOTER_MODES = ["replace", "status", "off"] as const;
export const IMAGE_SAVE_MODES = ["none", "project", "global", "custom"] as const;
export const IMAGE_OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;
export const PET_PLACEMENTS = [
  "stacked",
  "inline-left",
  "inline-right",
  "badge",
  "habitat",
] as const;
export const PET_STATES = [
  "idle",
  "running-right",
  "running-left",
  "waving",
  "jumping",
  "failed",
  "waiting",
  "running",
  "review",
] as const;

export type FooterMode = (typeof FOOTER_MODES)[number];
export type ImageSaveMode = (typeof IMAGE_SAVE_MODES)[number];
export type ImageOutputFormat = (typeof IMAGE_OUTPUT_FORMATS)[number];
export type PetPlacement = (typeof PET_PLACEMENTS)[number];
export type PetState = (typeof PET_STATES)[number];

export type UsageConfig = {
  enabled?: boolean;
  refreshIntervalMs?: number;
  showOnlyOnSubscriptionModels?: boolean;
  showResetTimes?: boolean;
};

export type FooterConfig = {
  mode?: FooterMode;
};

export type ImageConfig = {
  enabled?: boolean;
  defaultModel?: string;
  defaultSave?: ImageSaveMode;
  outputFormat?: ImageOutputFormat;
  timeoutMs?: number;
};

export type PetConfig = {
  enabled?: boolean;
  slug?: string;
  placement?: PetPlacement;
  state?: PetState;
  thinkingState?: PetState;
  toolState?: PetState;
  failedToolState?: PetState;
  idleEmotes?: boolean;
  idleEmoteIntervalMs?: number;
  sizeCells?: number;
};

export interface ConfigFile {
  persistState?: boolean;
  active?: boolean;
  desiredActive?: boolean;
  usage?: UsageConfig;
  footer?: FooterConfig;
  image?: ImageConfig;
  pets?: PetConfig;
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
  pets: Required<PetConfig>;
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

export const DEFAULT_IMAGE_CONFIG: Required<ImageConfig> = {
  enabled: true,
  defaultModel: "gpt-5.5",
  defaultSave: "project",
  outputFormat: "png",
  timeoutMs: 180_000,
};

export const DEFAULT_PET_CONFIG: Required<PetConfig> = {
  enabled: false,
  slug: "",
  placement: "inline-right",
  state: "idle",
  thinkingState: "review",
  toolState: "running",
  failedToolState: "failed",
  idleEmotes: true,
  idleEmoteIntervalMs: 30_000,
  sizeCells: 10,
};

export const DEFAULT_CONFIG: ConfigFile = {
  persistState: true,
  active: false,
  desiredActive: false,
  usage: DEFAULT_USAGE_CONFIG,
  footer: DEFAULT_FOOTER_CONFIG,
  image: DEFAULT_IMAGE_CONFIG,
  pets: DEFAULT_PET_CONFIG,
};
