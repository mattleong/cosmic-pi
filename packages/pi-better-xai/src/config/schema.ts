import * as Schema from "effect/Schema";

export const CONFIG_BASENAME = "pi-better-xai.json";
export const FOOTER_MODES = ["replace", "status", "off"] as const;
export const FooterModeSchema = Schema.Literals(FOOTER_MODES);
export type FooterMode = typeof FooterModeSchema.Type;

export const FiniteNumberSchema = Schema.Number.check(Schema.isFinite());

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
  mode: "status",
};
