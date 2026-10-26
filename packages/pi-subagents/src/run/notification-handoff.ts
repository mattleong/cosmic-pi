import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { completionNotificationKey } from "./completion.ts";
import type { CompletionGenerationRecord, RunRecord } from "./internal.ts";
import { MAX_TAKEN_REPORTS_PER_RUN } from "./limits.ts";
import { keepsTakingNotifications } from "./notification-routing.ts";

/** A report an ancestor run took during its open assignment. */
interface TakenReport {
  readonly source: RunRecord;
  readonly completion: CompletionGenerationRecord;
}

/**
 * What routing and delivery share about where notices go: the root's retirement, after which
 * every notice goes to the root session, and the reports each ancestor run took during its open
 * assignment, which it hands on unless that assignment completes. Changed only under the run lock.
 */
export function notificationHandoff(records: ReadonlyMap<string, RunRecord>) {
  const retirement = Deferred.makeUnsafe<void>();
  // By taking run, oldest first. A run's entries end with its assignment, so they stay bounded by
  // the reports one assignment takes, capped per run.
  const takenReports = new Map<string, Map<string, TakenReport>>();
  const isRetiring = (): boolean => Deferred.isDoneUnsafe(retirement);

  // Queues the report again under a new ancestor key. An unacknowledged copy is replaced, so the
  // delivery that took it doesn't delete it; one already replaced stays as it is. A consumed one
  // has no entry left, since consumption forgets it.
  const handOnLocked = ({ source, completion }: TakenReport): boolean => {
    if (records.get(source.view.id) !== source) return false;
    const current = source.completionGenerations.get(completion.generation);
    if (current !== undefined && current !== completion) return false;
    source.completionGenerations.set(completion.generation, {
      ...completion,
      handOns: (completion.handOns ?? 0) + 1,
    });
    return true;
  };

  const handOnAllLocked = (taken: Iterable<TakenReport>): boolean => {
    let handedOn = false;
    for (const report of taken) handedOn = handOnLocked(report) || handedOn;
    return handedOn;
  };

  return {
    /** Completes once the root starts retiring. */
    retired: Deferred.await(retirement),
    isRetiring,
    /**
     * Records that `recipient` took a report while its turn input was admitted, so no settlement
     * of it came between. A recipient that already stopped taking notices, or a retiring root,
     * hands it on at once.
     */
    takeReportLocked: (recipient: RunRecord, sourceRunId: string, generation: number): void => {
      const source = records.get(sourceRunId);
      const completion = source?.completionGenerations.get(generation);
      if (!source || !completion) return;
      if (
        isRetiring() ||
        records.get(recipient.view.id) !== recipient ||
        !keepsTakingNotifications(recipient)
      ) {
        handOnLocked({ source, completion });
        return;
      }
      const taken = takenReports.get(recipient.view.id) ?? new Map<string, TakenReport>();
      takenReports.set(recipient.view.id, taken);
      const key = completionNotificationKey(sourceRunId, generation);
      taken.delete(key);
      taken.set(key, { source, completion });
      // Past the cap the oldest counts as delivered, as every taken report did before hand-on.
      if (taken.size > MAX_TAKEN_REPORTS_PER_RUN) {
        const oldest = taken.keys().next();
        if (!oldest.done) taken.delete(oldest.value);
      }
    },
    /**
     * Forgets every run's take of a report an await or start result consumed, so no hand-on
     * repeats it.
     */
    forgetReportLocked: (sourceRunId: string, generation: number): void => {
      const key = completionNotificationKey(sourceRunId, generation);
      for (const taken of takenReports.values()) taken.delete(key);
    },
    /**
     * Ends `runId`'s open assignment: one that completed keeps the reports it took as delivered;
     * otherwise they are handed on. Returns whether any report was queued again.
     */
    endAssignmentLocked: (runId: string, completed: boolean): boolean => {
      const taken = takenReports.get(runId);
      takenReports.delete(runId);
      return !completed && taken !== undefined && handOnAllLocked(taken.values());
    },
    /**
     * Starts the root's retirement: every run that took a report is about to stop, so each goes to
     * the root. Returns whether any report was queued again.
     */
    retireLocked: (): boolean => {
      Deferred.doneUnsafe(retirement, Effect.void);
      const taken = [...takenReports.values()];
      takenReports.clear();
      let handedOn = false;
      for (const reports of taken) handedOn = handOnAllLocked(reports.values()) || handedOn;
      return handedOn;
    },
  };
}

export type NotificationHandoff = ReturnType<typeof notificationHandoff>;
