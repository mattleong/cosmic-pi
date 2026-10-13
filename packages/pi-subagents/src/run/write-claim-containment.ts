import * as Effect from "effect/Effect";
import type { SubagentError } from "./errors.ts";
import type { RunContext, RunRecord } from "./internal.ts";
import { hasSubagentCapability, isActiveRunState, type SubagentRunView } from "./model.ts";

interface RunWriteClaimContainmentDependencies extends Pick<
  RunContext,
  "ownerScope" | "withLock" | "records" | "publish"
> {
  readonly stop: (id: string) => Effect.Effect<SubagentRunView, SubagentError>;
  readonly interrupt: (id: string) => Effect.Effect<SubagentRunView, SubagentError>;
}

const containmentActionLocked = (record: RunRecord) => {
  const resumableInterrupt =
    hasSubagentCapability(record.view, "interrupt") && hasSubagentCapability(record.view, "resume");
  if (
    resumableInterrupt &&
    (record.view.state === "running" || record.view.state === "waiting_for_parent")
  )
    return "interrupt" as const;
  return isActiveRunState(record.view.state) &&
    record.view.state !== "paused" &&
    record.view.state !== "stopping"
    ? ("stop" as const)
    : undefined;
};

export function makeRunWriteClaimContainment(dependencies: RunWriteClaimContainmentDependencies) {
  const { ownerScope, withLock, records, publish, stop, interrupt } = dependencies;
  return (record: RunRecord, message: string): Effect.Effect<void> =>
    Effect.uninterruptible(
      withLock(
        Effect.gen(function* () {
          if (record.writeViolationContainmentStarted) return false;
          const pool = record.writerPool;
          if (!pool) return false;
          record.writeViolationContainmentStarted = true;
          pool.pauseAdmissionLocked(record.view.id, message);
          for (const memberId of pool.members.keys()) {
            const member = records.get(memberId);
            if (!member) continue;
            member.view = {
              ...member.view,
              writeAdmissionPaused: true,
              writeViolationOffender: pool.violationRunIds.has(memberId) ? true : undefined,
            };
          }
          yield* publish;
          return containmentActionLocked(record);
        }),
      ).pipe(
        Effect.flatMap((containmentAction) => {
          if (!containmentAction) return Effect.void;
          const stopAfterFailure = (interruptError?: SubagentError) =>
            stop(record.view.id).pipe(
              Effect.asVoid,
              Effect.catch((stopError) =>
                Effect.logWarning(
                  interruptError
                    ? `Could not contain write-claim violation after interrupt and stop failed: ${stopError.message}`
                    : `Could not contain write-claim violation because stop failed: ${stopError.message}`,
                ).pipe(Effect.annotateLogs("runId", record.view.id)),
              ),
            );
          const containment =
            containmentAction === "interrupt"
              ? interrupt(record.view.id).pipe(
                  Effect.asVoid,
                  Effect.catch((interruptError) => stopAfterFailure(interruptError)),
                )
              : stopAfterFailure();
          return containment.pipe(
            Effect.forkIn(ownerScope, { startImmediately: true }),
            Effect.asVoid,
          );
        }),
      ),
    );
}
