import type {
  SubagentCompletionNotification,
  SubagentNotificationDelivery,
} from "../boundary/host-notifier.ts";
import type { RunRecord } from "./internal.ts";

export const completionNotificationKey = (id: string, generation: number): string =>
  `${id}:${generation}`;

const isEligible = (record: RunRecord, generation: number): boolean =>
  record.view.state === "completed" &&
  record.completionGeneration === generation &&
  record.completionClaims === 0 &&
  record.completionConsumedGeneration < generation &&
  record.completionNotifiedGeneration < generation;

export function collectPendingCompletionNotifications(
  records: ReadonlyMap<string, RunRecord>,
  pending: Map<string, number>,
): ReadonlyArray<SubagentCompletionNotification> {
  const completed = [...pending.entries()].flatMap(([id, generation]) => {
    const record = records.get(id);
    if (!record || !isEligible(record, generation)) {
      pending.delete(id);
      return [];
    }
    return [
      {
        id: record.view.id,
        name: record.view.name,
        generation,
        ...(record.view.finalText ? { finalText: record.view.finalText } : {}),
      },
    ];
  });
  return completed.sort((left, right) =>
    left.id.localeCompare(right.id, undefined, { numeric: true }),
  );
}

export function deliveredCompletionKeys(
  delivery: unknown,
  runs: ReadonlyArray<SubagentCompletionNotification>,
): ReadonlySet<string> {
  if (
    typeof delivery === "object" &&
    delivery !== null &&
    "deliveredCompletionKeys" in delivery &&
    Array.isArray((delivery as SubagentNotificationDelivery).deliveredCompletionKeys)
  )
    return new Set((delivery as SubagentNotificationDelivery).deliveredCompletionKeys);
  // Existing embedders use void callbacks. A callback that returns normally is a
  // successful synchronous delivery unless it explicitly reports partial delivery.
  return new Set(runs.map((run) => completionNotificationKey(run.id, run.generation)));
}

export function acknowledgePendingCompletions(
  records: ReadonlyMap<string, RunRecord>,
  pending: Map<string, number>,
  runs: ReadonlyArray<SubagentCompletionNotification>,
  delivered: ReadonlySet<string>,
): void {
  for (const run of runs) {
    if (!delivered.has(completionNotificationKey(run.id, run.generation))) continue;
    const record = records.get(run.id);
    if (record && record.completionGeneration === run.generation)
      record.completionNotifiedGeneration = Math.max(
        record.completionNotifiedGeneration,
        run.generation,
      );
    if (pending.get(run.id) === run.generation) pending.delete(run.id);
  }
}

export function queuePendingCompletion(
  pending: Map<string, number>,
  record: RunRecord,
  generation: number,
): void {
  if (isEligible(record, generation)) pending.set(record.view.id, generation);
}
