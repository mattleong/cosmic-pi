import * as Schema from "effect/Schema";
import type { ScopedConfigMetadata, SubscriptionUsageConfig } from "pi-cosmic-core";

export const CONFIG_BASENAME = "pi-better-xai.json";

export const FiniteNumberSchema = Schema.Number.check(Schema.isFinite());

export interface ResolvedConfig extends ScopedConfigMetadata {
  readonly usage: SubscriptionUsageConfig;
}

export const DEFAULT_USAGE_CONFIG: ResolvedConfig["usage"] = {
  refreshIntervalMs: 60_000,
  showOnlyOnSubscriptionModels: true,
  showResetTimes: true,
};
