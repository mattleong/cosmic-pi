import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import type {
  SubagentCompletionNotification,
  SubagentNotificationDelivery,
} from "../boundary/host-notifier.ts";
import type { CompletionGenerationRecord, RunRecord } from "./internal.ts";
import { failedRunNextCandidate, isTerminalRunState } from "./model.ts";
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

/**
 * The failed outcomes a start call returns to its caller, claimed so neither a notice nor an
 * await repeats them while the call composes its result. Changed only under the run lock.
 */
export interface StartFailureHold {
  readonly claimToken: string;
  /** False once the call ended; a start that fails afterwards leaves its outcome to its notice. */
  open: boolean;
  /** Each held run's outcome generation, by run ID. */
  readonly held: Map<string, number>;
}

/**
 * Claims the generation a failing start's outcome takes before its settlement queues it, as an
 * await claims a working run's next outcome. Returns the generation, or undefined when the call
 * already ended or another operation owns that outcome.
 */
export const holdStartFailureLocked = (
  hold: StartFailureHold,
  record: RunRecord,
): number | undefined => {
  if (!hold.open) return undefined;
  const generation = record.completionGeneration + (isTerminalRunState(record.view.state) ? 0 : 1);
  if (!claimCompletion(record, generation, hold.claimToken)) return undefined;
  hold.held.set(record.view.id, generation);
  return generation;
};

/**
 * Keeps the hold only on a failed outcome, since the caller reports nothing else. Returns whether
 * it released the claim, which the caller follows by waking delivery.
 */
export const releaseUnlessStartFailedLocked = (
  hold: StartFailureHold,
  record: RunRecord,
  generation: number,
): boolean => {
  if (record.completionGenerations.get(generation)?.outcome === "failed") return false;
  hold.held.delete(record.view.id);
  return releaseCompletionClaim(record, generation, hold.claimToken);
};

const isCompletionEligible = (record: RunRecord, generation: number): boolean =>
  record.completionGenerations.has(generation) &&
  completionClaimOwner(record, generation) === undefined;

const completionNotification = (
  record: RunRecord,
  completion: CompletionGenerationRecord,
): SubagentCompletionNotification => {
  const nextCandidate =
    completion.outcome === "failed" ? failedRunNextCandidate(record.view) : undefined;
  return {
    id: record.view.id,
    name: record.launch.name,
    generation: completion.generation,
    outcome: completion.outcome,
    ...(completion.finalText && { finalText: completion.finalText }),
    ...(completion.finalTextTruncation && {
      finalTextTruncation: completion.finalTextTruncation,
    }),
    ...(completion.reportArchive && { reportArchive: completion.reportArchive }),
    ...(completion.error && { error: completion.error }),
    ...(completion.errorArchive && { errorArchive: completion.errorArchive }),
    ...(completion.warning && { warning: completion.warning }),
    ...(record.view.profile && { profile: record.view.profile }),
    ...(nextCandidate && { nextCandidate }),
    ...(record.view.workspaceId !== undefined && { workspaceId: record.view.workspaceId }),
    ...(record.view.workspaceOutcome && { workspaceOutcome: record.view.workspaceOutcome }),
  };
};

interface CompletionDeliverySelection {
  readonly record: RunRecord;
  readonly completion: CompletionGenerationRecord;
  readonly notification: SubagentCompletionNotification;
}

export function collectCompletionDeliveryBatch(
  records: ReadonlyMap<string, RunRecord>,
): ReadonlyArray<CompletionDeliverySelection> {
  const selected: CompletionDeliverySelection[] = [];
  // Records enter the map once, at admission, so its order delivers older runs first.
  for (const record of records.values()) {
    const completions = Arr.sort(
      [...record.completionGenerations.values()],
      Order.mapInput(
        Order.Number,
        (completion: CompletionGenerationRecord) => completion.generation,
      ),
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
      Arr.map(runs, (run) => completionNotificationKey(run.id, run.generation)),
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
