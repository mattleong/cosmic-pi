import * as Schema from "effect/Schema";

export const FOOTER_DENSITIES = ["auto", "comfortable", "compact"] as const;
export const MEDIA_PLACEMENTS = [
  "stacked",
  "inline-left",
  "inline-right",
  "badge",
  "habitat",
] as const;

export const FooterDensitySchema = Schema.Literals(FOOTER_DENSITIES);
export const MediaPlacementSchema = Schema.Literals(MEDIA_PLACEMENTS);
export type FooterDensity = typeof FooterDensitySchema.Type;
export type MediaPlacement = typeof MediaPlacementSchema.Type;

export interface CosmicUiConfigFile {
  readonly footer?: {
    readonly enabled?: boolean;
    readonly density?: FooterDensity;
    readonly order?: readonly string[];
    readonly hidden?: readonly string[];
    readonly mediaPlacement?: MediaPlacement;
  };
}

export interface ResolvedCosmicUiConfig {
  readonly configPath: string;
  readonly projectConfigPath: string;
  readonly globalConfigPath: string;
  readonly footer: {
    readonly enabled: boolean;
    readonly density: FooterDensity;
    readonly order: readonly string[];
    readonly hidden: readonly string[];
    readonly mediaPlacement: MediaPlacement;
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
] as const;

export const DEFAULT_CONFIG: { readonly footer: ResolvedCosmicUiConfig["footer"] } = {
  footer: {
    enabled: true,
    density: "auto",
    order: DEFAULT_FOOTER_ORDER,
    hidden: [],
    mediaPlacement: "inline-right",
  },
};
