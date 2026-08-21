import { type AgentSession, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Deferred from "effect/Deferred";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import type { SynchronousIngress } from "pi-cosmic-core";
import type { ResolvedAdvisorConfig } from "../config/options.ts";
import { AdvisorModelError, type AdvisorUsageTelemetry } from "./client.ts";
import {
  AdvisorFindingWireSchema,
  AdvisorSuggestionWireSchema,
  type AdvisorReview,
  type AdvisorReviewFocus,
} from "../review/index.ts";
import {
  MAX_ADVISOR_FINDINGS,
  MAX_ADVISOR_SUGGESTIONS,
  MAX_ADVISOR_SUMMARY_CHARS,
} from "../review/schema.ts";

export const MAX_ADVISOR_STATE_SUMMARY_CHARS = 4_000;
export const MAX_ADVISOR_CHECKPOINT_CHARS = 64_000;
export const MAX_ADVISOR_CHECKPOINT_ID_CHARS = 256;
export const MAX_ADVISOR_TOOL_ROUNDS = 12;
export const MAX_ADVISOR_STREAM_CHARS = 128_000;
export const DEFAULT_ADVISOR_SESSION_ABORT_TIMEOUT_MS = 30_000;
const CheckpointFields = {
  checkpointId: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(MAX_ADVISOR_CHECKPOINT_ID_CHARS),
  ),
  processedThrough: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  stateSummary: Schema.String.check(Schema.isMaxLength(MAX_ADVISOR_STATE_SUMMARY_CHARS)),
  verdict: Schema.Literals(["pass", "suggest", "revise"]),
  summary: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(MAX_ADVISOR_SUMMARY_CHARS)),
  suggestions: Schema.Array(AdvisorSuggestionWireSchema).check(
    Schema.isMaxLength(MAX_ADVISOR_SUGGESTIONS),
  ),
  findings: Schema.Array(AdvisorFindingWireSchema).check(Schema.isMaxLength(MAX_ADVISOR_FINDINGS)),
};
const UsageNumberSchema = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));
export const AdvisorUsageWireSchema = Schema.Struct({
  cacheRead: Schema.optional(UsageNumberSchema),
  cacheWrite: Schema.optional(UsageNumberSchema),
  input: Schema.optional(UsageNumberSchema),
  output: Schema.optional(UsageNumberSchema),
  totalTokens: Schema.optional(UsageNumberSchema),
  cost: Schema.optional(Schema.Struct({ total: Schema.optional(UsageNumberSchema) })),
});
export const AdvisorCheckpointWireSchema = Schema.Struct(CheckpointFields);
export class AdvisorRuntimeResetRequiredError extends AdvisorModelError {}
export interface AdvisorCheckpoint extends AdvisorReview {
  checkpointId: string;
  processedThrough: number;
  stateSummary: string;
}
export interface AdvisorCheckpointRequest {
  checkpointId: string;
  processedThrough: number;
  observations: string;
  focus: AdvisorReviewFocus;
  verificationReview?: AdvisorReview | undefined;
}
export interface AdvisorRuntimeStartOptions {
  ctx: Pick<ExtensionContext, "cwd" | "modelRegistry">;
  config: ResolvedAdvisorConfig;
  seed: string;
  stateSummary?: string | undefined;
  instructions?: string | undefined;
  onUsage?: ((usage: AdvisorUsageTelemetry) => void) | undefined;
  onDiagnostic?: ((message: string) => void) | undefined;
}
export interface ActiveCheckpointFinalization {
  epoch: number;
  finalPrompt: string;
  abortRequested: Deferred.Deferred<void>;
  finalization: Deferred.Deferred<void, AdvisorModelError>;
  finalizationQueued: boolean;
}

export interface AdvisorChildEvent {
  readonly epoch: number;
  readonly type: "stream" | "tool-round" | "message-end";
  readonly streamKind?: "thinking" | "text" | "tool";
  readonly text?: string;
  readonly stopReason?: string;
  readonly errorMessage?: string;
  readonly usage?: unknown;
}

export interface AdvisorFinalizationCompletion {
  readonly epoch: number;
  readonly succeeded: boolean;
}

export interface ActiveAdvisorChild {
  epoch: number;
  readonly session: AgentSession;
  readonly scope: Scope.Scope;
  readonly releaseState: { aborted: boolean };
  pendingEvents: number;
  readonly events: SynchronousIngress<AdvisorChildEvent>;
  readonly finalizations: SynchronousIngress<AdvisorFinalizationCompletion>;
}
export interface AdvisorAbortSelection {
  readonly active: ActiveAdvisorChild | undefined;
}
export interface AdvisorForcedDetach {
  readonly active: ActiveAdvisorChild | undefined;
  readonly publishDiagnostic: boolean;
}
