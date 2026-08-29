import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type * as Effect from "effect/Effect";
import type { AdvisorConfigPatch, ResolvedAdvisorConfig } from "../config/options.ts";
import type { AdvisorConfigStoreError } from "../config/store.ts";
import type { AdvisorSessionMetrics } from "../domain/metrics.ts";

export type AdvisorActivity = "idle" | "queued" | "reviewing";

export interface AdvisorCommandSnapshot {
  readonly config: ResolvedAdvisorConfig;
  readonly metrics: Readonly<AdvisorSessionMetrics>;
  readonly activity: AdvisorActivity;
  readonly hasLastCandidate: boolean;
}

export interface AdvisorCommandState {
  readonly snapshot: AdvisorCommandSnapshot;
  /** Session-owned commit keeps persistence and authoritative state in one Effect. */
  readonly persist: (
    patch: AdvisorConfigPatch,
    path: string,
  ) => Effect.Effect<ResolvedAdvisorConfig, AdvisorConfigStoreError>;
}

export type AdvisorReviewRequestResult = "started" | "unavailable" | "cancelled";
export type AdvisorCardActionResult =
  | "applied"
  | "unavailable"
  | "delivery-failed"
  | "state-failed";

export interface AdvisorCommandActions {
  cancel(ctx: ExtensionCommandContext): Effect.Effect<boolean>;
  fixLast(ctx: ExtensionCommandContext): AdvisorCardActionResult;
  dismissLast(ctx: ExtensionCommandContext): AdvisorCardActionResult;
  reviewLast(ctx: ExtensionCommandContext): Effect.Effect<AdvisorReviewRequestResult>;
}
