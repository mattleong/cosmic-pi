import { createHash } from "node:crypto";
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

const SEVERITIES = ["nit", "concern", "blocker"] as const satisfies readonly AdvisorSeverity[];
const CATEGORIES = [
  "intent",
  "correctness",
  "completeness",
  "evidence",
] as const satisfies readonly AdvisorFindingCategory[];

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
  if (!isRecord(value)) return undefined;
  if (value.protocolVersion !== ADVISOR_CHECKPOINT_PROTOCOL_VERSION) return undefined;
  if (typeof value.fingerprint !== "string" || !/^[a-f\d]{64}$/i.test(value.fingerprint))
    return undefined;
  if (typeof value.anchorId !== "string" || !value.anchorId) return undefined;
  const reviewSummary = parseReviewSummary(value.reviewSummary);
  if (!reviewSummary || !isRecord(value.routing)) return undefined;
  if (typeof value.routing.cancellationLatched !== "boolean") return undefined;
  const completedPrimaryTurns = value.routing.completedPrimaryTurns ?? 0;
  if (
    typeof completedPrimaryTurns !== "number" ||
    !Number.isSafeInteger(completedPrimaryTurns) ||
    completedPrimaryTurns < 0
  )
    return undefined;
  if (
    typeof value.routing.immunityUntilCompletedTurn !== "number" ||
    !Number.isSafeInteger(value.routing.immunityUntilCompletedTurn) ||
    value.routing.immunityUntilCompletedTurn < 0
  )
    return undefined;
  if (
    !Array.isArray(value.emissionHashes) ||
    value.emissionHashes.length > MAX_LEDGER_EMISSION_HASHES ||
    !value.emissionHashes.every(isEmissionRecord)
  )
    return undefined;
  return {
    protocolVersion: ADVISOR_CHECKPOINT_PROTOCOL_VERSION,
    fingerprint: value.fingerprint,
    anchorId: value.anchorId,
    reviewSummary,
    routing: {
      cancellationLatched: value.routing.cancellationLatched,
      completedPrimaryTurns,
      immunityUntilCompletedTurn: value.routing.immunityUntilCompletedTurn,
      ...(isRecord(value.routing.interventionBudget)
        ? {
            interventionBudget: sanitizeInterventionBudgetSnapshot(
              value.routing.interventionBudget,
            ),
          }
        : {}),
    },
    ...(Array.isArray(value.findingLifecycle)
      ? { findingLifecycle: sanitizeFindingLifecycle(value.findingLifecycle) }
      : {}),
    emissionHashes: [...value.emissionHashes],
  };
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
  if (!isRecord(value)) return undefined;
  if (value.verdict !== "none" && value.verdict !== "pass" && value.verdict !== "revise") {
    return undefined;
  }
  if (!isRecord(value.severityCounts) || !isRecord(value.categoryCounts)) return undefined;
  if (!hasExactCountKeys(value.severityCounts, SEVERITIES)) return undefined;
  if (!hasExactCountKeys(value.categoryCounts, CATEGORIES)) return undefined;
  return {
    verdict: value.verdict,
    severityCounts: {
      nit: Number(value.severityCounts.nit),
      concern: Number(value.severityCounts.concern),
      blocker: Number(value.severityCounts.blocker),
    },
    categoryCounts: {
      intent: Number(value.categoryCounts.intent),
      correctness: Number(value.categoryCounts.correctness),
      completeness: Number(value.categoryCounts.completeness),
      evidence: Number(value.categoryCounts.evidence),
    },
  };
}

function hasExactCountKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    expected.every((key, index) => (key === actual[index] ? isBoundedCount(value[key]) : false))
  );
}

function isBoundedCount(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 5;
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
