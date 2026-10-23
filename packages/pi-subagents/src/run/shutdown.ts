import * as Effect from "effect/Effect";
import { SubagentRuntimeClosedError } from "./errors.ts";
import { beginCleanup, isCleanupOwed, type RunContext } from "./internal.ts";
import type { RunRecordCleanup } from "./record-cleanup.ts";
import { leafFirst } from "./tree.ts";

interface RunShutdownDependencies extends Pick<RunContext, "records" | "withLock"> {
  readonly cleanup: RunRecordCleanup;
}

export const closeRunsLeafFirst = (dependencies: RunShutdownDependencies): Effect.Effect<void> => {
  const { records, withLock, cleanup } = dependencies;
  return Effect.forEach(
    leafFirst(records.values()),
    (record) =>
      // Fibers in the record's still-open scope may be mid-transition, so stop under the lock.
      withLock(
        Effect.sync(() => {
          record.stoppedByParent = true;
          record.process?.cancelPending(
            SubagentRuntimeClosedError.make({ message: "Parent session shut down." }),
          );
          if (record.closingScope !== record.scope) beginCleanup(record);
        }),
      ).pipe(
        Effect.andThen(cleanup.closeRecordScope(record)),
        Effect.andThen(
          withLock(Effect.sync(() => !isCleanupOwed(record) && record.process === undefined)),
        ),
        Effect.flatMap((safeToReclaim) =>
          safeToReclaim
            ? cleanup
                .reclaimRecordRunState(record)
                .pipe(Effect.catch(() => cleanup.retainCleanupQuarantine(record, record.scope)))
            : Effect.void,
        ),
      ),
    { concurrency: 1, discard: true },
  );
};
