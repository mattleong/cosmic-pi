export const FOOTER_DENSITIES = ["auto", "comfortable", "compact"] as const;
export const MEDIA_PLACEMENTS = [
  "stacked",
  "inline-left",
  "inline-right",
  "badge",
  "habitat",
] as const;

export type FooterDensity = (typeof FOOTER_DENSITIES)[number];
export type MediaPlacement = (typeof MEDIA_PLACEMENTS)[number];

export interface CosmicUiConfigFile {
  footer?: {
    enabled?: boolean;
    density?: FooterDensity;
    order?: string[];
    hidden?: string[];
    mediaPlacement?: MediaPlacement;
  };
}

export interface ResolvedCosmicUiConfig {
  configPath: string;
  projectConfigPath: string;
  globalConfigPath: string;
  footer: {
    enabled: boolean;
    density: FooterDensity;
    order: string[];
    hidden: string[];
    mediaPlacement: MediaPlacement;
  };
}

export const DEFAULT_FOOTER_ORDER = [
  "model",
  "effort",
  "location",
  "openai.fast",
  "branch",
  "pullRequest",
  "git",
  "context",
  "session",
  "metrics",
  "openai.usage",
  "xai.usage",
  "extensions",
];

export const DEFAULT_CONFIG: Required<CosmicUiConfigFile> = {
  footer: {
    enabled: true,
    density: "auto",
    order: DEFAULT_FOOTER_ORDER,
    hidden: [],
    mediaPlacement: "inline-right",
  },
};
