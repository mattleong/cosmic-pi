import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as MutableRef from "effect/MutableRef";
import { formatTimestampOrNever, maskIdentifier } from "pi-cosmic-core";
import { BILLING_BASE_URL } from "./format.ts";
import type { XaiProjection } from "./projection.ts";

export function formatDebug(
  projection: MutableRef.MutableRef<XaiProjection>,
  ctx: ExtensionContext,
): string {
  const state = MutableRef.get(projection);
  const cfg = state.config;
  const formatTime = formatTimestampOrNever;
  return [
    `Usage enabled: ${cfg?.usage.enabled ?? false}`,
    `Current model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none"}`,
    `Current model eligible: ${state.eligible}`,
    `Requires subscription model: ${cfg?.usage.showOnlyOnSubscriptionModels ?? true}`,
    `Auth: ${state.authFound ? "found" : "missing"}`,
    `Team ID: ${maskIdentifier(state.teamId) ?? "none"}`,
    `Last fetch: ${formatTime(state.lastFetchAt)}`,
    `Last successful update: ${formatTime(state.updatedAt)}`,
    `Last error: ${state.error ?? "none"}`,
    `Refresh interval: ${cfg?.usage.refreshIntervalMs ?? 60_000}ms`,
    `Endpoint: ${BILLING_BASE_URL}/billing*`,
    `Auth file: ${state.authPath ?? "unknown"}`,
  ].join("\n");
}
