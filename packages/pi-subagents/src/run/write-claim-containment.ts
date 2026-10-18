import * as Effect from "effect/Effect";
import type { SubagentError } from "./errors.ts";
import type { RunContext, RunRecord } from "./internal.ts";
import { isActiveRunState, type SubagentRunView } from "./model.ts";

interface RunWriteClaimContainmentDependencies extends Pick<RunContext, "ownerScope" | "withLock"> {
  readonly stop: (id: string) => Effect.Effect<SubagentRunView, SubagentError>;
}

/**
 * Stops only the writer that wrote outside its fixed claims. Peers keep running and admission
 * stays open; the parent relaunches with corrected claims if the work is still needed.
 */
export function writeClaimContainment(dependencies: RunWriteClaimContainmentDependencies) {
  const { ownerScope, withLock, stop } = dependencies;
  return (record: RunRecord): Effect.Effect<void> =>
    Effect.uninterruptible(
      withLock(
        Effect.sync(() => {
          if (
            record.writeViolationContainmentStarted ||
            !isActiveRunState(record.view.state) ||
            record.view.state === "stopping"
          )
            return false;
          record.writeViolationContainmentStarted = true;
          return true;
        }),
      ).pipe(
        Effect.flatMap((started) =>
          started
            ? stop(record.view.id).pipe(
                Effect.asVoid,
                Effect.catch((error) =>
                  Effect.logWarning(
                    `Could not stop a writer after a write-claim violation: ${error.message}`,
                  ).pipe(Effect.annotateLogs("runId", record.view.id)),
                ),
                Effect.forkIn(ownerScope, { startImmediately: true }),
                Effect.asVoid,
              )
            : Effect.void,
        ),
      ),
    );
}
