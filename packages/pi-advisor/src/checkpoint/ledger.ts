import * as Predicate from "effect/Predicate";

import { createHash } from "node:crypto";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { snapshotData, snapshotDataRecord } from "../domain/safe-data.ts";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  isValidAdvisorFindingRecord,
  MAX_FINDING_LIFECYCLE_RECORDS,
  type AdvisorFindingRecord,
} from "../review/finding-lifecycle.ts";
import {
  sanitizeInterventionBudgetSnapshot,
  type AdvisorInterventionBudgetSnapshot,
} from "../review/intervention-budget.ts";
import type { AdvisorReview } from "../review/schema.ts";
import { isJsonObject } from "pi-cosmic-core";

export const ADVISOR_CHECKPOINT_ENTRY_TYPE = "pi-advisor-checkpoint";
export const ADVISOR_CHECKPOINT_PROTOCOL_VERSION = 3;
export const MAX_LEDGER_EMISSION_HASHES = 32;

const BoundedCountSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: 5 }),
);
const ReviewSummaryWireSchema = Schema.Struct({
  verdict: Schema.Literals(["none", "pass", "revise"]),
  severityCounts: Schema.Struct({
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
  severity: Schema.Literals(["concern", "blocker"]),
  status: Schema.Literals(["open", "acknowledged", "resolved", "superseded"]),
  firstSeenTurn: NonNegativeIntSchema,
  lastSeenTurn: NonNegativeIntSchema,
});
const InterventionBudgetWireSchema = Schema.Struct({
  delivered: NonNegativeIntSchema,
  correctionUsed: Schema.Boolean,
  highestSeverity: Schema.optionalKey(Schema.Literals(["concern", "blocker"])),
});
const CheckpointLedgerFields = {
  protocolVersion: Schema.Literal(ADVISOR_CHECKPOINT_PROTOCOL_VERSION),
  fingerprint: Schema.String.check(Schema.isPattern(/^[a-f\d]{64}$/i)),
  anchorId: Schema.String.check(Schema.isNonEmpty()),
  reviewSummary: ReviewSummaryWireSchema,
  emissionHashes: Schema.Array(
    Schema.String.check(Schema.isPattern(/^(?:concern|blocker):[a-f\d]{64}$/i)),
  ).check(Schema.isMaxLength(MAX_LEDGER_EMISSION_HASHES)),
};
const CheckpointRoutingFields = {
  cancellationLatched: Schema.Boolean,
  immunityUntilCompletedTurn: NonNegativeIntSchema,
};
const AdvisorCheckpointLedgerInputSchema = Schema.Struct({
  ...CheckpointLedgerFields,
  reviewSummary: ReviewSummaryWireSchema.annotate({
    parseOptions: { onExcessProperty: "error" },
  }),
  routing: Schema.Struct({
    ...CheckpointRoutingFields,
    completedPrimaryTurns: Schema.optional(NonNegativeIntSchema),
  }),
});
export const AdvisorCheckpointLedgerWireSchema = Schema.Struct({
  ...CheckpointLedgerFields,
  routing: Schema.Struct({
    ...CheckpointRoutingFields,
    completedPrimaryTurns: NonNegativeIntSchema,
    interventionBudget: Schema.optional(InterventionBudgetWireSchema),
  }),
  findingLifecycle: Schema.optional(
    Schema.Array(FindingLifecycleWireSchema).check(
      Schema.isMaxLength(MAX_FINDING_LIFECYCLE_RECORDS),
    ),
  ),
});

export type AdvisorDurableReviewSummary = Schema.Schema.Type<typeof ReviewSummaryWireSchema>;
export type AdvisorCheckpointLedger = Schema.Schema.Type<typeof AdvisorCheckpointLedgerWireSchema>;

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
      JSON.stringify({
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
  return JSON.stringify(summary);
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
  const routing: AdvisorCheckpointLedger["routing"] = {
    cancellationLatched: input.cancellationLatched ?? false,
    completedPrimaryTurns: Math.max(0, Math.floor(input.completedPrimaryTurns ?? 0)),
    immunityUntilCompletedTurn: Math.max(0, Math.floor(input.immunityUntilCompletedTurn ?? 0)),
  };
  const ledger: AdvisorCheckpointLedger = {
    protocolVersion: ADVISOR_CHECKPOINT_PROTOCOL_VERSION,
    fingerprint: input.fingerprint,
    anchorId: input.anchorId,
    reviewSummary: sanitizeReviewSummary(input.reviewSummary),
    routing: input.interventionBudget
      ? {
          ...routing,
          interventionBudget: sanitizeInterventionBudgetSnapshot(input.interventionBudget),
        }
      : routing,
    emissionHashes: (input.emissionHashes ?? [])
      .filter(isEmissionRecord)
      .slice(-MAX_LEDGER_EMISSION_HASHES),
  };
  return input.findingLifecycle
    ? { ...ledger, findingLifecycle: sanitizeFindingLifecycle(input.findingLifecycle) }
    : ledger;
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
      !isJsonObject(entry.data)
    )
      continue;
    const ledger = parseLedger(entry.data);
    if (!ledger || ledger.fingerprint !== fingerprint || !ancestry.has(ledger.anchorId)) continue;
    return ledger;
  }
  return undefined;
}

export function parseLedger<ValueInput>(value: ValueInput): AdvisorCheckpointLedger | undefined {
  const snapshot = snapshotDataRecord(value);
  if (!snapshot) return undefined;
  const routing = snapshotDataRecord(snapshot.routing);
  if (!routing) return undefined;
  const decoded = Schema.decodeUnknownOption(AdvisorCheckpointLedgerInputSchema, {
    onExcessProperty: "ignore",
  })(snapshot);
  if (Option.isNone(decoded)) return undefined;
  const input = decoded.value;
  const lifecycleSnapshot = snapshotData(snapshot.findingLifecycle);
  const interventionBudget = snapshotDataRecord(routing.interventionBudget);
  const parsedRouting: AdvisorCheckpointLedger["routing"] = {
    ...input.routing,
    completedPrimaryTurns: input.routing.completedPrimaryTurns ?? 0,
  };
  const base: AdvisorCheckpointLedger = {
    ...input,
    routing: interventionBudget
      ? {
          ...parsedRouting,
          interventionBudget: sanitizeInterventionBudgetSnapshot(interventionBudget),
        }
      : parsedRouting,
  };
  const ledger: AdvisorCheckpointLedger = Array.isArray(lifecycleSnapshot)
    ? { ...base, findingLifecycle: sanitizeFindingLifecycle(lifecycleSnapshot) }
    : base;
  const validated = Schema.decodeUnknownOption(AdvisorCheckpointLedgerWireSchema, {
    onExcessProperty: "error",
  })(ledger);
  return Option.isSome(validated) ? validated.value : undefined;
}

function emptyReviewSummary(verdict: AdvisorDurableReviewSummary["verdict"] = "none") {
  return {
    verdict,
    severityCounts: { concern: 0, blocker: 0 },
    categoryCounts: { intent: 0, correctness: 0, completeness: 0, evidence: 0 },
  };
}

function sanitizeReviewSummary(
  value: AdvisorDurableReviewSummary | undefined,
): AdvisorDurableReviewSummary {
  return parseReviewSummary(value) ?? emptyReviewSummary();
}

function parseReviewSummary<ValueInput>(
  value: ValueInput,
): AdvisorDurableReviewSummary | undefined {
  const decoded = Schema.decodeUnknownOption(ReviewSummaryWireSchema)(snapshotData(value));
  return Option.isSome(decoded) ? decoded.value : undefined;
}

function sanitizeFindingLifecycle(values: readonly unknown[]): AdvisorFindingRecord[] {
  return values.slice(-MAX_FINDING_LIFECYCLE_RECORDS).flatMap((value): AdvisorFindingRecord[] => {
    if (!isValidAdvisorFindingRecord(value)) return [];
    return [
      {
        id: value.id,
        key: value.key,
        generation: value.generation,
        category: value.category,
        severity: value.severity,
        status: value.status,
        firstSeenTurn: value.firstSeenTurn,
        lastSeenTurn: value.lastSeenTurn,
      },
    ];
  });
}

function isEmissionRecord<ValueInput>(value: ValueInput): value is ValueInput & string {
  return Predicate.isString(value) && /^(?:concern|blocker):[a-f\d]{64}$/i.test(value);
}
