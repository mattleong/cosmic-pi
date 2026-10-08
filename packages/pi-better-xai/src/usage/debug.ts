import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as MutableRef from "effect/MutableRef";
import { formatUsageDebugReport, invokeHostCallback } from "pi-cosmic-core";
import { DEFAULT_USAGE_CONFIG } from "../config/schema.ts";
import { BILLING_BASE_URL } from "./format.ts";
import type { XaiProjection } from "./projection.ts";

export function formatDebug(
  projection: MutableRef.MutableRef<XaiProjection>,
  ctx: ExtensionContext,
): string {
  const state = MutableRef.get(projection);
  const usage = state.config?.usage ?? DEFAULT_USAGE_CONFIG;
  return formatUsageDebugReport(state, {
    currentModel: invokeHostCallback(() => {
      const model = ctx.model;
      return model ? `${model.provider}/${model.id}` : "none";
    }, "none"),
    requiresSubscriptionModel: usage.showOnlyOnSubscriptionModels,
    identityLabel: "Team ID",
    identityValue: state.teamId,
    refreshIntervalMs: usage.refreshIntervalMs,
    endpoint: `${BILLING_BASE_URL}/billing*`,
  });
}
