import type {
  SubagentCompletionNotification,
  SubagentNotificationDelivery,
} from "../boundary/host-notifier.ts";
import type { RunRecord } from "./internal.ts";
import { MAX_UNRESOLVED_REPORT_GENERATIONS } from "./limits.ts";

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

export const isCompletionEligible = (record: RunRecord, generation: number): boolean =>
  record.completionGenerations.has(generation) &&
  completionClaimOwner(record, generation) === undefined;

export function collectPendingCompletionNotifications(
  records: ReadonlyMap<string, RunRecord>,
  pending: Map<string, { readonly id: string; readonly generation: number }>,
): ReadonlyArray<SubagentCompletionNotification> {
  const completed = [...pending.entries()].flatMap(([key, receipt]) => {
    const record = records.get(receipt.id);
    const completion = record?.completionGenerations.get(receipt.generation);
    if (!record || !completion || !isCompletionEligible(record, receipt.generation)) {
      if (!completion) pending.delete(key);
      return [];
    }
    return [
      (() => {
        const objectPart2006_0 = {
          id: record.view.id,
          name: record.view.name,
          generation: receipt.generation,
          outcome: completion.outcome,
        };
        const objectPart2006_1 = completion.finalText
          ? { ...objectPart2006_0, finalText: completion.finalText }
          : objectPart2006_0;
        const objectPart2006_2 = completion.error
          ? { ...objectPart2006_1, error: completion.error }
          : objectPart2006_1;
        const objectPart2006_3 = completion.warning
          ? { ...objectPart2006_2, warning: completion.warning }
          : objectPart2006_2;
        const objectPart2006_4 = completion.retained
          ? { ...objectPart2006_3, retained: true }
          : objectPart2006_3;
        return objectPart2006_4;
      })(),
    ];
  });
  return completed.sort((left, right) => {
    const idOrder = left.id.localeCompare(right.id, undefined, { numeric: true });
    return idOrder === 0 ? left.generation - right.generation : idOrder;
  });
}

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

export function acknowledgePendingCompletions(
  records: ReadonlyMap<string, RunRecord>,
  pending: Map<string, { readonly id: string; readonly generation: number }>,
  runs: ReadonlyArray<SubagentCompletionNotification>,
  delivered: ReadonlySet<string>,
): number {
  let acknowledged = 0;
  for (const run of runs) {
    const key = completionNotificationKey(run.id, run.generation);
    if (!delivered.has(key)) continue;
    const record = records.get(run.id);
    record?.completionGenerations.delete(run.generation);
    pending.delete(key);
    acknowledged += 1;
  }
  return acknowledged;
}

export function queuePendingCompletion(
  pending: Map<string, { readonly id: string; readonly generation: number }>,
  record: RunRecord,
  generation: number,
): void {
  if (!isCompletionEligible(record, generation)) return;
  const receipt = { id: record.view.id, generation };
  pending.set(completionNotificationKey(receipt.id, receipt.generation), receipt);
}

export function removePendingCompletion(
  pending: Map<string, { readonly id: string; readonly generation: number }>,
  id: string,
  generation: number,
): void {
  pending.delete(completionNotificationKey(id, generation));
}
