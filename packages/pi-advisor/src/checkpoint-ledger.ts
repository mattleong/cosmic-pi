import { stringifyJson } from "./boundary/json.ts";
import { createHash } from "node:crypto";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { snapshotData, snapshotDataRecord } from "./boundary/safe-data.ts";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  isValidAdvisorFindingRecord,
  MAX_FINDING_LIFECYCLE_RECORDS,
  type AdvisorFindingRecord,
} from "./finding-lifecycle.ts";
import {
  sanitizeInterventionBudgetSnapshot,
  type AdvisorInterventionBudgetSnapshot,
} from "./intervention-budget.ts";
import type { AdvisorFindingCategory, AdvisorReview, AdvisorSeverity } from "./review.ts";
import { isRecord } from "./utils.ts";

export const ADVISOR_CHECKPOINT_ENTRY_TYPE = "pi-advisor-checkpoint";
export const ADVISOR_CHECKPOINT_PROTOCOL_VERSION = 2;
export const MAX_LEDGER_EMISSION_HASHES = 32;

const BoundedCountSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: 5 }),
);
const ReviewSummaryWireSchema = Schema.Struct({
  verdict: Schema.Literals(["none", "pass", "revise"]),
  severityCounts: Schema.Struct({
    nit: BoundedCountSchema,
    concern: BoundedCountSchema,
    blocker: BoundedCountSchema,
  }),
  categoryCounts: Schema.Struct({
    intent: BoundedCountSchema,
    correctness: BoundedCountSchema,
    completeness: BoundedCountSchema,
    evidence: BoundedCountSchema,
  }),
});
const NonNegativeIntSchema = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const FindingLifecycleWireSchema = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^af_[a-f\d]{32}$/)),
  key: Schema.String.check(Schema.isPattern(/^[a-f\d]{64}$/)),
  generation: NonNegativeIntSchema,
  category: Schema.Literals(["intent", "correctness", "completeness", "evidence"]),
  severity: Schema.Literals(["nit", "concern", "blocker"]),
  status: Schema.Literals(["open", "acknowledged", "resolved", "superseded"]),
  firstSeenTurn: NonNegativeIntSchema,
  lastSeenTurn: NonNegativeIntSchema,
});
const InterventionBudgetWireSchema = Schema.Struct({
  delivered: NonNegativeIntSchema,
  correctionUsed: Schema.Boolean,
  highestSeverity: Schema.optional(Schema.Literals(["nit", "concern", "blocker"])),
});
const AdvisorCheckpointLedgerInputSchema = Schema.Struct({
  protocolVersion: Schema.Literal(2),
  fingerprint: Schema.String.check(Schema.isPattern(/^[a-f\d]{64}$/i)),
  anchorId: Schema.String.check(Schema.isNonEmpty()),
  reviewSummary: ReviewSummaryWireSchema,
  routing: Schema.Struct({
    cancellationLatched: Schema.Boolean,
    completedPrimaryTurns: Schema.optional(NonNegativeIntSchema),
    immunityUntilCompletedTurn: NonNegativeIntSchema,
  }),
  emissionHashes: Schema.Array(
    Schema.String.check(Schema.isPattern(/^(?:nit|concern|blocker):[a-f\d]{64}$/i)),
  ).check(Schema.isMaxLength(MAX_LEDGER_EMISSION_HASHES)),
});
export const AdvisorCheckpointLedgerWireSchema = Schema.Struct({
  protocolVersion: Schema.Literal(2),
  fingerprint: Schema.String.check(Schema.isPattern(/^[a-f\d]{64}$/i)),
  anchorId: Schema.String.check(Schema.isNonEmpty()),
  reviewSummary: ReviewSummaryWireSchema,
  routing: Schema.Struct({
    cancellationLatched: Schema.Boolean,
    completedPrimaryTurns: NonNegativeIntSchema,
    immunityUntilCompletedTurn: NonNegativeIntSchema,
    interventionBudget: Schema.optional(InterventionBudgetWireSchema),
  }),
  findingLifecycle: Schema.optional(
    Schema.Array(FindingLifecycleWireSchema).check(
      Schema.isMaxLength(MAX_FINDING_LIFECYCLE_RECORDS),
    ),
  ),
  emissionHashes: Schema.Array(
    Schema.String.check(Schema.isPattern(/^(?:nit|concern|blocker):[a-f\d]{64}$/i)),
  ).check(Schema.isMaxLength(MAX_LEDGER_EMISSION_HASHES)),
});

export interface AdvisorDurableReviewSummary {
  verdict: "none" | "pass" | "revise";
  severityCounts: Record<AdvisorSeverity, number>;
  categoryCounts: Record<AdvisorFindingCategory, number>;
}

export interface AdvisorCheckpointLedger {
  protocolVersion: 2;
  fingerprint: string;
  anchorId: string;
  reviewSummary: AdvisorDurableReviewSummary;
  routing: {
    cancellationLatched: boolean;
    completedPrimaryTurns: number;
    immunityUntilCompletedTurn: number;
    interventionBudget?: AdvisorInterventionBudgetSnapshot;
  };
  findingLifecycle?: AdvisorFindingRecord[];
  emissionHashes: string[];
}

export interface LedgerFingerprintInput {
  provider: string;
  model: string;
  cwd: string;
  guidance: string;
  fastMode: boolean;
  thinkingLevel: string;
}

export function createLedgerFingerprint(input: LedgerFingerprintInput): string {
  return createHash("sha256")
    .update(
      stringifyJson({
        provider: input.provider,
        model: input.model,
        cwd: input.cwd,
        guidance: input.guidance,
        fastMode: input.fastMode,
        thinkingLevel: input.thinkingLevel,
        protocolVersion: ADVISOR_CHECKPOINT_PROTOCOL_VERSION,
      }),
    )
    .digest("hex");
}

export function summarizeAdvisorReview(review?: AdvisorReview): AdvisorDurableReviewSummary {
  // Perspective guidance is request-scoped and intentionally not restored as durable correction state.
  const verdict = review?.verdict === "suggest" ? "pass" : (review?.verdict ?? "none");
  const summary = emptyReviewSummary(verdict);
  for (const finding of review?.findings ?? []) {
    summary.severityCounts[finding.severity] += 1;
    summary.categoryCounts[finding.category] += 1;
  }
  return summary;
}

/** Render only extension-owned closed enums and bounded counts for child re-prime context. */
export function renderDurableReviewSummary(summary: AdvisorDurableReviewSummary): string {
  return stringifyJson(summary);
}

export function createCheckpointLedger(input: {
  fingerprint: string;
  anchorId: string;
  reviewSummary?: AdvisorDurableReviewSummary;
  cancellationLatched?: boolean;
  completedPrimaryTurns?: number;
  immunityUntilCompletedTurn?: number;
  interventionBudget?: AdvisorInterventionBudgetSnapshot;
  findingLifecycle?: readonly AdvisorFindingRecord[];
  emissionHashes?: readonly string[];
}): AdvisorCheckpointLedger {
  return {
    protocolVersion: ADVISOR_CHECKPOINT_PROTOCOL_VERSION,
    fingerprint: input.fingerprint,
    anchorId: input.anchorId,
    reviewSummary: sanitizeReviewSummary(input.reviewSummary),
    routing: {
      cancellationLatched: input.cancellationLatched ?? false,
      completedPrimaryTurns: Math.max(0, Math.floor(input.completedPrimaryTurns ?? 0)),
      immunityUntilCompletedTurn: Math.max(0, Math.floor(input.immunityUntilCompletedTurn ?? 0)),
      ...(input.interventionBudget
        ? { interventionBudget: sanitizeInterventionBudgetSnapshot(input.interventionBudget) }
        : {}),
    },
    ...(input.findingLifecycle
      ? { findingLifecycle: sanitizeFindingLifecycle(input.findingLifecycle) }
      : {}),
    emissionHashes: (input.emissionHashes ?? [])
      .filter(isEmissionRecord)
      .slice(-MAX_LEDGER_EMISSION_HASHES),
  };
}

/** Restore only a valid ledger whose anchor remains on the active branch. */
export function restoreCheckpointLedger(
  branch: readonly SessionEntry[],
  fingerprint: string,
): AdvisorCheckpointLedger | undefined {
  const ancestry = new Set(branch.map((entry) => entry.id));
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (
      entry?.type !== "custom" ||
      entry.customType !== ADVISOR_CHECKPOINT_ENTRY_TYPE ||
      !isRecord(entry.data)
    )
      continue;
    const ledger = parseLedger(entry.data);
    if (!ledger || ledger.fingerprint !== fingerprint || !ancestry.has(ledger.anchorId)) continue;
    return ledger;
  }
  return undefined;
}

export function parseLedger(value: unknown): AdvisorCheckpointLedger | undefined {
  const snapshot = snapshotDataRecord(value);
  if (!snapshot) return undefined;
  const routing = snapshotDataRecord(snapshot.routing);
  if (!routing) return undefined;
  const schemaInput = {
    protocolVersion: snapshot.protocolVersion,
    fingerprint: snapshot.fingerprint,
    anchorId: snapshot.anchorId,
    reviewSummary: snapshot.reviewSummary,
    routing: {
      cancellationLatched: routing.cancellationLatched,
      completedPrimaryTurns: routing.completedPrimaryTurns,
      immunityUntilCompletedTurn: routing.immunityUntilCompletedTurn,
    },
    emissionHashes: snapshot.emissionHashes,
  };
  const decoded = Schema.decodeUnknownOption(AdvisorCheckpointLedgerInputSchema, {
    onExcessProperty: "error",
  })(schemaInput);
  if (Option.isNone(decoded)) return undefined;
  const input = decoded.value;
  const routingSnapshot = routing;
  const lifecycleSnapshot = snapshotData(snapshot.findingLifecycle);
  const ledger: AdvisorCheckpointLedger = {
    protocolVersion: ADVISOR_CHECKPOINT_PROTOCOL_VERSION,
    fingerprint: input.fingerprint,
    anchorId: input.anchorId,
    reviewSummary: input.reviewSummary,
    routing: {
      cancellationLatched: input.routing.cancellationLatched,
      completedPrimaryTurns: input.routing.completedPrimaryTurns ?? 0,
      immunityUntilCompletedTurn: input.routing.immunityUntilCompletedTurn,
      ...(snapshotDataRecord(routingSnapshot?.interventionBudget)
        ? {
            interventionBudget: sanitizeInterventionBudgetSnapshot(
              snapshotDataRecord(routingSnapshot?.interventionBudget)!,
            ),
          }
        : {}),
    },
    ...(Array.isArray(lifecycleSnapshot)
      ? { findingLifecycle: sanitizeFindingLifecycle(lifecycleSnapshot) }
      : {}),
    emissionHashes: [...input.emissionHashes],
  };
  return Option.isSome(Schema.decodeUnknownOption(AdvisorCheckpointLedgerWireSchema)(ledger))
    ? ledger
    : undefined;
}

function emptyReviewSummary(
  verdict: AdvisorDurableReviewSummary["verdict"] = "none",
): AdvisorDurableReviewSummary {
  return {
    verdict,
    severityCounts: { nit: 0, concern: 0, blocker: 0 },
    categoryCounts: { intent: 0, correctness: 0, completeness: 0, evidence: 0 },
  };
}

function sanitizeReviewSummary(
  value: AdvisorDurableReviewSummary | undefined,
): AdvisorDurableReviewSummary {
  return parseReviewSummary(value) ?? emptyReviewSummary();
}

function parseReviewSummary(value: unknown): AdvisorDurableReviewSummary | undefined {
  const decoded = Schema.decodeUnknownOption(ReviewSummaryWireSchema)(snapshotData(value));
  return Option.isSome(decoded) ? decoded.value : undefined;
}

function sanitizeFindingLifecycle(values: readonly unknown[]): AdvisorFindingRecord[] {
  return values
    .slice(-MAX_FINDING_LIFECYCLE_RECORDS)
    .flatMap((value): AdvisorFindingRecord[] =>
      isValidAdvisorFindingRecord(value) ? [{ ...value }] : [],
    );
}

function isEmissionRecord(value: unknown): value is string {
  return typeof value === "string" && /^(?:nit|concern|blocker):[a-f\d]{64}$/i.test(value);
}
