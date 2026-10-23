import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as MutableRef from "effect/MutableRef";
import { formatDuration, maskIdentifier } from "pi-cosmic-core";
import { currentModelKey } from "../fast/controller.ts";
import { formatTimestampOrNever, USAGE_URL } from "./format.ts";
import type { OpenAIProjection } from "./projection.ts";

export function formatDebug(
  projection: MutableRef.MutableRef<OpenAIProjection>,
  ctx: ExtensionContext,
): string {
  const state = MutableRef.get(projection);
  const cfg = state.config;
  return Arr.join(
    [
      `Current model: ${currentModelKey(ctx)}`,
      `Current model eligible: ${state.eligible}`,
      `Requires subscription model: ${cfg?.usage.showOnlyOnSubscriptionModels ?? true}`,
      `Auth: ${state.authFound ? "found" : "missing"}`,
      `Account ID: ${maskIdentifier(state.accountId) ?? "none"}`,
      `Last fetch: ${formatTimestampOrNever(state.lastFetchAt)}`,
      `Last successful update: ${formatTimestampOrNever(state.updatedAt)}`,
      `Last error: ${state.error ?? "none"}`,
      `Refresh interval: ${formatDuration(cfg?.usage.refreshIntervalMs ?? 60_000)}`,
      `Endpoint: ${USAGE_URL}`,
      `Auth file: ${state.authPath ?? "unknown"}`,
    ],
    "\n",
  );
}
