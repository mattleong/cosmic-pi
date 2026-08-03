import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AdvisorConfigPatch, ResolvedAdvisorConfig } from "../config/options.ts";
import type { AdvisorSessionMetrics } from "../domain/metrics.ts";

export interface AdvisorConfigState {
  get(): ResolvedAdvisorConfig;
  getMetrics(): Readonly<AdvisorSessionMetrics>;
  /** Session-owned adapter commits persistence and authoritative state together. */
  persist(patch: AdvisorConfigPatch, path: string): Promise<ResolvedAdvisorConfig>;
}

export type AdvisorReviewRequestResult = "started" | "unavailable" | "cancelled";
export type AdvisorCardActionResult =
  | "applied"
  | "unavailable"
  | "delivery-failed"
  | "state-failed";

export interface AdvisorCommandActions {
  cancel(ctx: ExtensionCommandContext): boolean | Promise<boolean>;
  fixLast(ctx: ExtensionCommandContext): AdvisorCardActionResult;
  dismissLast(ctx: ExtensionCommandContext): AdvisorCardActionResult;
  reviewLast(
    ctx: ExtensionCommandContext,
  ): AdvisorReviewRequestResult | Promise<AdvisorReviewRequestResult>;
}

export interface AdvisorCommandRegistrar {
  readonly registerCommand: ExtensionAPI["registerCommand"];
}
