import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as MutableRef from "effect/MutableRef";
import { formatUsageDebugReport } from "pi-cosmic-core";
import { BILLING_BASE_URL } from "./format.ts";
import type { XaiProjection } from "./projection.ts";

export function formatDebug(
  projection: MutableRef.MutableRef<XaiProjection>,
  ctx: ExtensionContext,
): string {
  const state = MutableRef.get(projection);
  const cfg = state.config;
  return formatUsageDebugReport({
    usageEnabled: cfg?.usage.enabled ?? false,
    currentModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none",
    eligible: state.eligible,
    requiresSubscriptionModel: cfg?.usage.showOnlyOnSubscriptionModels ?? true,
    auth: state.authFound ? "found" : "missing",
    identityLabel: "Team ID",
    identityValue: state.teamId,
    lastFetchAt: state.lastFetchAt,
    updatedAt: state.updatedAt,
    error: state.error,
    refreshIntervalMs: cfg?.usage.refreshIntervalMs ?? 60_000,
    endpoint: `${BILLING_BASE_URL}/billing*`,
    authPath: state.authPath,
  });
}
