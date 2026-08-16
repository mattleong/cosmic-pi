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

export const CosmicUiFooterConfigSchema = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  density: Schema.optional(FooterDensitySchema),
  order: Schema.optional(Schema.Array(Schema.String)),
  hidden: Schema.optional(Schema.Array(Schema.String)),
  mediaPlacement: Schema.optional(MediaPlacementSchema),
});
export const CosmicUiConfigFileSchema = Schema.Struct({
  footer: Schema.optional(CosmicUiFooterConfigSchema),
});
export type CosmicUiConfigFile = typeof CosmicUiConfigFileSchema.Type;

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

export const DEFAULT_CONFIG = {
  footer: {
    enabled: true,
    density: "auto",
    order: DEFAULT_FOOTER_ORDER,
    hidden: [],
    mediaPlacement: "inline-right",
  },
} satisfies { readonly footer: ResolvedCosmicUiConfig["footer"] };
