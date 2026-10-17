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

/**
 * `pool` pauses admission for the whole cwd pool; `offender` contains only the writer, unless
 * its pool is already paused.
 */
export type WriteClaimViolationScope = "pool" | "offender";

export function writeClaimContainment(dependencies: RunWriteClaimContainmentDependencies) {
  const { ownerScope, withLock, records, publish, stop, interrupt } = dependencies;
  return (
    record: RunRecord,
    message: string,
    scope: WriteClaimViolationScope,
  ): Effect.Effect<void> =>
    Effect.uninterruptible(
      withLock(
        Effect.gen(function* () {
          const pool = record.writerPool;
          if (!pool) return undefined;
          const poolWide = scope === "pool" || pool.admissionPaused;
          const alreadyContained = record.writeViolationContainmentStarted;
          // A later workspace violation escalates an offender-only containment already in progress.
          if (alreadyContained && (!poolWide || pool.violationRunIds.has(record.view.id)))
            return undefined;
          record.writeViolationContainmentStarted = true;
          if (poolWide) {
            // Offender-only offenders join the pool's offender set, so one recovery covers them.
            const offenderIds = [...pool.members.keys()].filter(
              (memberId) => records.get(memberId)?.view.writeViolationOffender === true,
            );
            pool.pauseAdmissionLocked([record.view.id, ...offenderIds], message);
            for (const memberId of pool.members.keys()) {
              const member = records.get(memberId);
              if (!member) continue;
              member.view = {
                ...member.view,
                writeAdmissionPaused: true,
                writeViolationOffender: pool.violationRunIds.has(memberId) ? true : undefined,
              };
            }
          } else record.view = { ...record.view, writeViolationOffender: true };
          yield* publish;
          return alreadyContained ? undefined : containmentActionLocked(record);
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
