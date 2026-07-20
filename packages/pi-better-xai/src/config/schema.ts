import * as Schema from "effect/Schema";

export const FOOTER_MODES = ["replace", "status", "off"] as const;
export const FooterModeSchema = Schema.Literals(FOOTER_MODES);
export type FooterMode = typeof FooterModeSchema.Type;

const FiniteNumberSchema = Schema.Number.check(Schema.isFinite());

export const UsageConfigSchema = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  refreshIntervalMs: Schema.optional(FiniteNumberSchema),
  showOnlyOnSubscriptionModels: Schema.optional(Schema.Boolean),
  showResetTimes: Schema.optional(Schema.Boolean),
});
export type UsageConfig = typeof UsageConfigSchema.Type;

export const FooterConfigSchema = Schema.Struct({
  mode: Schema.optional(FooterModeSchema),
});
export type FooterConfig = typeof FooterConfigSchema.Type;

export const ConfigFileSchema = Schema.Struct({
  usage: Schema.optional(UsageConfigSchema),
  footer: Schema.optional(FooterConfigSchema),
});
export type ConfigFile = typeof ConfigFileSchema.Type;

export interface ResolvedConfig {
  readonly configPath: string;
  readonly projectConfigPath: string;
  readonly globalConfigPath: string;
  readonly projectConfigExists: boolean;
  readonly globalConfigExists: boolean;
  readonly usage: {
    readonly enabled: boolean;
    readonly refreshIntervalMs: number;
    readonly showOnlyOnSubscriptionModels: boolean;
    readonly showResetTimes: boolean;
  };
  readonly footer: {
    readonly mode: FooterMode;
  };
}

export const DEFAULT_USAGE_CONFIG: ResolvedConfig["usage"] = {
  enabled: true,
  refreshIntervalMs: 60_000,
  showOnlyOnSubscriptionModels: true,
  showResetTimes: true,
};

export const DEFAULT_FOOTER_CONFIG: ResolvedConfig["footer"] = {
  mode: "replace",
};

export const DEFAULT_CONFIG: ConfigFile = {
  usage: DEFAULT_USAGE_CONFIG,
  footer: DEFAULT_FOOTER_CONFIG,
};
