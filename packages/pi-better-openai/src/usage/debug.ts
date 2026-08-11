import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as MutableRef from "effect/MutableRef";
import { formatUsageDebugReport } from "pi-cosmic-core";
import { currentModelKey } from "../fast/controller.ts";
import { USAGE_URL } from "./format.ts";
import type { OpenAIProjection } from "./projection.ts";

export function formatDebug(
  projection: MutableRef.MutableRef<OpenAIProjection>,
  ctx: ExtensionContext,
): string {
  const state = MutableRef.get(projection);
  const cfg = state.config;
  return formatUsageDebugReport({
    usageEnabled: cfg?.usage.enabled ?? false,
    currentModel: currentModelKey(ctx),
    eligible: state.eligible,
    requiresSubscriptionModel: cfg?.usage.showOnlyOnSubscriptionModels ?? true,
    auth: state.authFound ? `found (${state.authSource ?? "unknown"})` : "missing",
    identityLabel: "Account ID",
    identityValue: state.accountId,
    lastFetchAt: state.lastFetchAt,
    updatedAt: state.updatedAt,
    error: state.error,
    refreshIntervalMs: cfg?.usage.refreshIntervalMs ?? 60_000,
    endpoint: USAGE_URL,
    authPath: state.authPath,
  });
}
