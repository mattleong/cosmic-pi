import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AdvisorConfigPatch, ResolvedAdvisorConfig } from "../config/options.ts";
import type { AdvisorSessionMetrics } from "../domain/metrics.ts";
import type { AdvisorReviewFocus } from "../review/index.ts";

export interface AdvisorConfigState {
  get(): ResolvedAdvisorConfig;
  getMetrics(): Readonly<AdvisorSessionMetrics>;
  update(config: ResolvedAdvisorConfig): void | Promise<void>;
  /** Session-owned adapter commits persistence and authoritative state together. */
  persist?(patch: AdvisorConfigPatch, path: string): Promise<ResolvedAdvisorConfig>;
}

export type AdvisorReviewRequestResult = "started" | "unavailable" | "cancelled";

export interface AdvisorCommandActions {
  cancel(ctx: ExtensionCommandContext): boolean | Promise<boolean>;
  pause(ctx: ExtensionCommandContext): void;
  resume(ctx: ExtensionCommandContext): void;
  reviewLast(
    ctx: ExtensionCommandContext,
    focus: AdvisorReviewFocus,
  ): AdvisorReviewRequestResult | Promise<AdvisorReviewRequestResult>;
  reviewNext(ctx: ExtensionCommandContext): void;
}

export interface AdvisorCommandRegistrar {
  readonly registerCommand: ExtensionAPI["registerCommand"];
}
