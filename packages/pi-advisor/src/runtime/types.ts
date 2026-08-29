import { type AgentSession, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Deferred from "effect/Deferred";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import * as Scope from "effect/Scope";
import type { SynchronousIngress } from "pi-cosmic-core";
import type { ResolvedAdvisorConfig } from "../config/options.ts";
import { redactSensitiveText } from "../domain/redaction.ts";
import {
  AdvisorReviewFieldsSchema,
  makeAdvisorReviewFingerprintFilter,
  makeAdvisorReviewLaneFilter,
  makeAdvisorReviewSizeFilter,
  type AdvisorReview,
  type AdvisorReviewFocus,
} from "../review/schema.ts";
import { AdvisorModelError, type AdvisorUsageTelemetry } from "./client.ts";

export const MAX_ADVISOR_STATE_SUMMARY_CHARS = 4_000;
export const MAX_ADVISOR_CHECKPOINT_CHARS = 64_000;
export const MAX_ADVISOR_CHECKPOINT_ID_CHARS = 256;
export const MAX_ADVISOR_TOOL_ROUNDS = 12;
export const MAX_ADVISOR_STREAM_CHARS = 128_000;
export const DEFAULT_ADVISOR_SESSION_ABORT_TIMEOUT_MS = 30_000;
export const ADVISOR_STATE_SUMMARY_SIZE_FILTER_IDENTIFIER =
  "pi-advisor/checkpoint/state-summary-size";

const CheckpointIdSchema = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_ADVISOR_CHECKPOINT_ID_CHARS),
);
const RawStateSummarySchema = Schema.String.check(
  Schema.makeFilter((summary: string) => summary.length <= MAX_ADVISOR_STATE_SUMMARY_CHARS, {
    identifier: ADVISOR_STATE_SUMMARY_SIZE_FILTER_IDENTIFIER,
  }),
);
const StateSummarySchema = RawStateSummarySchema.pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform(redactSensitiveText),
    encode: SchemaGetter.transform((summary) => summary),
  }),
);
const AdvisorCheckpointFieldsSchema = Schema.Struct({
  checkpointId: CheckpointIdSchema,
  processedThrough: Schema.Natural,
  stateSummary: StateSummarySchema,
  ...AdvisorReviewFieldsSchema.fields,
});
const AdvisorCheckpointEncodedInputSchema = Schema.toEncoded(AdvisorCheckpointFieldsSchema);
const AdvisorCheckpointBoundedEncodedSchema = AdvisorCheckpointEncodedInputSchema.check(
  makeAdvisorReviewSizeFilter<Schema.Schema.Type<typeof AdvisorCheckpointEncodedInputSchema>>(),
);
const AdvisorCheckpointNormalizedSchema = AdvisorCheckpointBoundedEncodedSchema.pipe(
  Schema.decodeTo(AdvisorCheckpointFieldsSchema),
);
type StrictAdvisorCheckpoint = Schema.Schema.Type<typeof AdvisorCheckpointNormalizedSchema>;
export const AdvisorCheckpointSchema = AdvisorCheckpointNormalizedSchema.check(
  makeAdvisorReviewLaneFilter<StrictAdvisorCheckpoint>(),
  makeAdvisorReviewFingerprintFilter<StrictAdvisorCheckpoint>(),
);

const UsageNumberSchema = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));
export const AdvisorUsageWireSchema = Schema.Struct({
  cacheRead: Schema.optional(UsageNumberSchema),
  cacheWrite: Schema.optional(UsageNumberSchema),
  input: Schema.optional(UsageNumberSchema),
  output: Schema.optional(UsageNumberSchema),
  totalTokens: Schema.optional(UsageNumberSchema),
  cost: Schema.optional(Schema.Struct({ total: Schema.optional(UsageNumberSchema) })),
});
export class AdvisorRuntimeResetRequiredError extends AdvisorModelError {}
export type AdvisorCheckpoint = Schema.Schema.Type<typeof AdvisorCheckpointSchema>;
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
