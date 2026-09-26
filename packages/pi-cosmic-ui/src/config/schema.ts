import * as Schema from "effect/Schema";
import type { ScopedConfigMetadata } from "pi-cosmic-core";

export const FOOTER_DENSITIES = ["auto", "comfortable", "compact"] as const;

export const FooterDensitySchema = Schema.Literals(FOOTER_DENSITIES);
export type FooterDensity = typeof FooterDensitySchema.Type;

interface FooterConfig {
  readonly enabled: boolean;
  readonly density: FooterDensity;
  readonly order: readonly string[];
  readonly hidden: readonly string[];
}

export interface CosmicUiConfigFile {
  readonly footer?: Partial<FooterConfig>;
}

export interface ResolvedCosmicUiConfig extends ScopedConfigMetadata {
  readonly footer: FooterConfig;
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
  },
} satisfies { readonly footer: FooterConfig };

export const makeDefaultResolvedCosmicUiConfig = (): ResolvedCosmicUiConfig => ({
  configPath: "",
  projectConfigPath: "",
  globalConfigPath: "",
  projectConfigExists: false,
  globalConfigExists: false,
  footer: {
    ...DEFAULT_CONFIG.footer,
    order: [...DEFAULT_CONFIG.footer.order],
    hidden: [...DEFAULT_CONFIG.footer.hidden],
  },
});
