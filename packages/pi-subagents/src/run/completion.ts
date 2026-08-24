import type {
  SubagentCompletionNotification,
  SubagentNotificationDelivery,
} from "../boundary/host-notifier.ts";
import type { CompletionGenerationRecord, RunRecord } from "./internal.ts";
import {
  MAX_COMPLETION_DELIVERY_BATCH,
  MAX_UNRESOLVED_REPORT_GENERATIONS,
  MAX_UNRESOLVED_REPORTS_BEFORE_RETAINED_ASSIGNMENT,
} from "./limits.ts";

export const completionNotificationKey = (id: string, generation: number): string =>
  `${id}:${generation}`;

export const completionClaimOwner = (record: RunRecord, generation: number): string | undefined =>
  record.completionClaims.get(generation);

export const hasCompletionGenerationCapacity = (record: RunRecord): boolean =>
  record.completionGenerations.size < MAX_UNRESOLVED_REPORT_GENERATIONS;

export const hasRetainedAssignmentCapacity = (record: RunRecord): boolean =>
  record.completionGenerations.size < MAX_UNRESOLVED_REPORTS_BEFORE_RETAINED_ASSIGNMENT;

export const claimCompletion = (
  record: RunRecord,
  generation: number,
  claimToken: string,
): boolean => {
  const owner = completionClaimOwner(record, generation);
  if (owner !== undefined && owner !== claimToken) return false;
  record.completionClaims.set(generation, claimToken);
  return true;
};

export const releaseCompletionClaim = (
  record: RunRecord,
  generation: number,
  claimToken: string,
): boolean => {
  if (completionClaimOwner(record, generation) !== claimToken) return false;
  record.completionClaims.delete(generation);
  return true;
};

export const isCompletionEligible = (record: RunRecord, generation: number): boolean =>
  record.completionGenerations.has(generation) &&
  completionClaimOwner(record, generation) === undefined;

const completionNotification = (
  record: RunRecord,
  completion: CompletionGenerationRecord,
): SubagentCompletionNotification => {
  const baseResult = {
    id: record.view.id,
    name: record.view.name,
    generation: completion.generation,
    outcome: completion.outcome,
  };
  const withFinalText = completion.finalText
    ? { ...baseResult, finalText: completion.finalText }
    : baseResult;
  const withError = completion.error
    ? { ...withFinalText, error: completion.error }
    : withFinalText;
  const withWarning = completion.warning
    ? { ...withError, warning: completion.warning }
    : withError;
  const withRetained = completion.retained ? { ...withWarning, retained: true } : withWarning;
  const remainingCandidateCount = record.view.remainingCandidateCount ?? 0;
  const retryAvailable =
    completion.outcome === "failed" &&
    record.view.reportGeneration === 0 &&
    remainingCandidateCount > 0 &&
    record.view.retryExhausted !== true &&
    record.view.retryBlocked !== true &&
    record.view.supersededByRunId === undefined &&
    !record.assignment.outcomeUncertain;
  const withProfile = record.view.profile
    ? { ...withRetained, profile: record.view.profile }
    : withRetained;
  return retryAvailable
    ? { ...withProfile, retryAvailable: true, remainingCandidateCount }
    : withProfile;
};

export interface CompletionDeliverySelection {
  readonly record: RunRecord;
  readonly completion: CompletionGenerationRecord;
  readonly notification: SubagentCompletionNotification;
}

const compareRecordIds = (left: RunRecord, right: RunRecord): number =>
  left.view.id.localeCompare(right.view.id, undefined, { numeric: true });

/** Caller must hold the service lock. */
export function collectCompletionDeliveryBatch(
  records: ReadonlyMap<string, RunRecord>,
): ReadonlyArray<CompletionDeliverySelection> {
  const selected: CompletionDeliverySelection[] = [];
  for (const record of [...records.values()].sort(compareRecordIds)) {
    const completions = [...record.completionGenerations.values()].sort(
      (left, right) => left.generation - right.generation,
    );
    for (const completion of completions) {
      if (!isCompletionEligible(record, completion.generation)) continue;
      selected.push({
        record,
        completion,
        notification: completionNotification(record, completion),
      });
      if (selected.length === MAX_COMPLETION_DELIVERY_BATCH) return selected;
    }
  }
  return selected;
}

/** Caller must hold the service lock. */
export const hasEligibleCompletion = (records: ReadonlyMap<string, RunRecord>): boolean => {
  for (const record of records.values())
    for (const generation of record.completionGenerations.keys())
      if (isCompletionEligible(record, generation)) return true;
  return false;
};

export function deliveredCompletionKeys(
  delivery: SubagentNotificationDelivery | undefined,
  runs: ReadonlyArray<SubagentCompletionNotification>,
): ReadonlySet<string> {
  // Existing embedders use void callbacks. A callback that returns normally is a
  // successful synchronous delivery unless it explicitly reports partial delivery.
  return new Set(
    delivery?.deliveredCompletionKeys ??
      runs.map((run) => completionNotificationKey(run.id, run.generation)),
  );
}

/** Caller must hold the service lock and the completion gate. */
export function acknowledgeCompletionSelections(
  selected: ReadonlyArray<CompletionDeliverySelection>,
  delivered: ReadonlySet<string>,
): number {
  let acknowledged = 0;
  for (const item of selected) {
    const generation = item.completion.generation;
    if (!delivered.has(completionNotificationKey(item.record.view.id, generation))) continue;
    if (item.record.completionGenerations.get(generation) !== item.completion) continue;
    if (completionClaimOwner(item.record, generation) !== undefined) continue;
    item.record.completionGenerations.delete(generation);
    acknowledged += 1;
  }
  return acknowledged;
}
