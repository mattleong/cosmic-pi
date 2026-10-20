import type {
  SubagentCompletionNotification,
  SubagentNotificationDelivery,
} from "../boundary/host-notifier.ts";
import type { CompletionGenerationRecord, RunRecord } from "./internal.ts";
import { hasUnresolvedSteeringDelivery } from "./model.ts";
import { MAX_COMPLETION_DELIVERY_BATCH, MAX_UNRESOLVED_REPORT_GENERATIONS } from "./limits.ts";

export const completionNotificationKey = (id: string, generation: number): string =>
  `${id}:${generation}`;

export const completionClaimOwner = (record: RunRecord, generation: number): string | undefined =>
  record.completionClaims.get(generation);

export const hasCompletionGenerationCapacity = (record: RunRecord): boolean =>
  record.completionGenerations.size < MAX_UNRESOLVED_REPORT_GENERATIONS;

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

const isCompletionEligible = (record: RunRecord, generation: number): boolean =>
  record.completionGenerations.has(generation) &&
  completionClaimOwner(record, generation) === undefined;

const completionNotification = (
  record: RunRecord,
  completion: CompletionGenerationRecord,
): SubagentCompletionNotification => {
  const remainingCandidateCount = record.view.remainingCandidateCount ?? 0;
  const retryAvailable =
    completion.outcome === "failed" &&
    record.assignment.epoch === 1 &&
    remainingCandidateCount > 0 &&
    record.view.retryExhausted !== true &&
    record.view.retryBlocked !== true &&
    record.view.supersededByRunId === undefined &&
    !record.assignment.outcomeUncertain &&
    !hasUnresolvedSteeringDelivery(record.view);
  return {
    id: record.view.id,
    name: record.view.name,
    generation: completion.generation,
    outcome: completion.outcome,
    ...(completion.finalText && { finalText: completion.finalText }),
    ...(completion.finalTextTruncation && {
      finalTextTruncation: completion.finalTextTruncation,
    }),
    ...(completion.reportArchive && { reportArchive: completion.reportArchive }),
    ...(completion.error && { error: completion.error }),
    ...(completion.warning && { warning: completion.warning }),
    ...(completion.resumedBy !== undefined && { resumedBy: completion.resumedBy }),
    ...(record.view.profile && { profile: record.view.profile }),
    ...(retryAvailable && { retryAvailable: true, remainingCandidateCount }),
    ...(record.view.workspaceId !== undefined && { workspaceId: record.view.workspaceId }),
    ...(record.view.workspaceOutcome && { workspaceOutcome: record.view.workspaceOutcome }),
  };
};

interface CompletionDeliverySelection {
  readonly record: RunRecord;
  readonly completion: CompletionGenerationRecord;
  readonly notification: SubagentCompletionNotification;
}

const compareRecordIds = (left: RunRecord, right: RunRecord): number =>
  left.view.id.localeCompare(right.view.id, undefined, { numeric: true });

export function collectCompletionDeliveryBatch(
  records: ReadonlyMap<string, RunRecord>,
): ReadonlyArray<CompletionDeliverySelection> {
  const selected: CompletionDeliverySelection[] = [];
  for (const record of [...records.values()].toSorted(compareRecordIds)) {
    const completions = [...record.completionGenerations.values()].toSorted(
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
  return new Set(
    delivery?.deliveredCompletionKeys ??
      runs.map((run) => completionNotificationKey(run.id, run.generation)),
  );
}

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
