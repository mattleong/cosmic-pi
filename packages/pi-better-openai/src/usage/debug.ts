import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as MutableRef from "effect/MutableRef";
import { formatTimestampOrNever, maskIdentifier } from "pi-cosmic-core";
import { currentModelKey } from "../fast/controller.ts";
import { USAGE_URL } from "./format.ts";
import { isOpenAISubscriptionModel, type OpenAIProjection } from "./projection.ts";

export function formatDebug(
  projection: MutableRef.MutableRef<OpenAIProjection>,
  ctx: ExtensionContext,
): string {
  const state = MutableRef.get(projection);
  const cfg = state.config;
  const time = formatTimestampOrNever;
  return [
    `Usage enabled: ${cfg?.usage.enabled ?? false}`,
    `Current model: ${currentModelKey(ctx)}`,
    `Current model eligible: ${cfg ? isOpenAISubscriptionModel(ctx, cfg) : false}`,
    `Requires subscription model: ${cfg?.usage.showOnlyOnSubscriptionModels ?? true}`,
    `Auth: ${state.authFound ? `found (${state.authSource ?? "unknown"})` : "missing"}`,
    `Account ID: ${maskIdentifier(state.accountId) ?? "none"}`,
    `Last fetch: ${time(state.lastFetchAt)}`,
    `Last successful update: ${time(state.updatedAt)}`,
    `Last error: ${state.error ?? "none"}`,
    `Refresh interval: ${cfg?.usage.refreshIntervalMs ?? 60_000}ms`,
    `Endpoint: ${USAGE_URL}`,
    `Auth file: ${state.authPath ?? "unknown"}`,
  ].join("\n");
}
