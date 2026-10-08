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
  return formatUsageDebugReport(state, {
    currentModel: currentModelKey(ctx),
    requiresSubscriptionModel: cfg?.usage.showOnlyOnSubscriptionModels ?? true,
    identityLabel: "Account ID",
    identityValue: state.accountId,
    refreshIntervalMs: cfg?.usage.refreshIntervalMs ?? 60_000,
    endpoint: USAGE_URL,
  });
}
