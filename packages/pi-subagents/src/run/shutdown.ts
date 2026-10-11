import * as Effect from "effect/Effect";
import { SubagentRuntimeClosedError } from "./errors.ts";
import type { RunContext } from "./internal.ts";
import type { RunRecordCleanup } from "./record-cleanup.ts";
import { leafFirst } from "./tree.ts";

interface RunShutdownDependencies extends Pick<RunContext, "records" | "withLock"> {
  readonly cleanup: RunRecordCleanup;
}

export const closeRunsLeafFirst = (dependencies: RunShutdownDependencies): Effect.Effect<void> => {
  const { records, withLock, cleanup } = dependencies;
  return Effect.forEach(
    leafFirst(records.values()),
    (record) => {
      record.stoppedByParent = true;
      record.process?.cancelPending(
        new SubagentRuntimeClosedError({ message: "Parent session shut down." }),
      );
      if (record.closingScope !== record.scope) record.cleanupPending = true;
      return cleanup.closeRecordScope(record).pipe(
        Effect.andThen(
          withLock(Effect.sync(() => !record.cleanupPending && record.process === undefined)),
        ),
        Effect.flatMap((safeToReclaim) =>
          safeToReclaim
            ? cleanup
                .reclaimRecordRunState(record)
                .pipe(Effect.catch(() => cleanup.retainCleanupQuarantine(record, record.scope)))
            : Effect.void,
        ),
      );
    },
    { concurrency: 1, discard: true },
  );
};
