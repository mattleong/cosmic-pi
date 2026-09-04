import * as Schema from "effect/Schema";

export const CONFIG_BASENAME = "pi-better-xai.json";

export const FiniteNumberSchema = Schema.Number.check(Schema.isFinite());

export interface ResolvedConfig {
  readonly configPath: string;
  readonly projectConfigPath: string;
  readonly globalConfigPath: string;
  readonly projectConfigExists: boolean;
  readonly globalConfigExists: boolean;
  readonly usage: {
    readonly refreshIntervalMs: number;
    readonly showOnlyOnSubscriptionModels: boolean;
    readonly showResetTimes: boolean;
  };
}

export const DEFAULT_USAGE_CONFIG: ResolvedConfig["usage"] = {
  refreshIntervalMs: 60_000,
  showOnlyOnSubscriptionModels: true,
  showResetTimes: true,
};
