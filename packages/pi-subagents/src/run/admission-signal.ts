import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { CanonicalWriterCwd } from "../boundary/writer-lease.ts";
import { DEFAULT_SUBAGENT_NESTING_POLICY } from "../config/schema.ts";
import { normalizeWriteClaims } from "../domain/write-claims.ts";
import {
  admissionHoldings,
  type HeldLaunchSlots,
  workflowCapacityError,
  writerConflictError,
} from "./admission.ts";
import { SubagentRuntimeClosedError, type SubagentWriterConflictError } from "./errors.ts";
import type { RunContext, RunRecord } from "./internal.ts";
import { SUBAGENT_ROOT_RUN_ID, type StartSubagentRequest } from "./model.ts";
import type { WriterPoolEntry } from "./writer-pool.ts";

/**
 * A revision that advances only when a holding that can refuse a start is released, so a start
 * refused for capacity or a writer conflict retries when it could succeed, not on every
 * progress event. Every method is synchronous over the service's records.
 */
export function makeRunAdmissionSignal(
  records: ReadonlyMap<string, RunRecord>,
  writerPools: ReadonlyMap<string, WriterPoolEntry>,
  /** Holdings kept outside the records, such as slots of launches acquiring workspaces. */
  external: () => Iterable<string> = () => [],
) {
  let revision = 0;
  const snapshot = (): ReadonlySet<string> =>
    new Set([...admissionHoldings(records, writerPools), ...external()]);
  let holdings = snapshot();
  let changed = Deferred.makeUnsafe<void, SubagentRuntimeClosedError>();
  let closed = false;

  /** Recomputes holdings after a change; advances the revision when any of them is gone. */
  const observe = (): void => {
    if (closed) return;
    const next = snapshot();
    const released = [...holdings].some((holding) => !next.has(holding));
    holdings = next;
    if (!released) return;
    revision += 1;
    const settled = changed;
    changed = Deferred.makeUnsafe();
    Deferred.doneUnsafe(settled, Effect.void);
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    Deferred.doneUnsafe(
      changed,
      Effect.fail(new SubagentRuntimeClosedError({ message: "Parent session shut down." })),
    );
  };

  const current = Effect.sync(() => revision);

  const waitForChange = (after: number): Effect.Effect<void, SubagentRuntimeClosedError> =>
    Effect.suspend(() =>
      revision > after
        ? Effect.void
        : closed
          ? Effect.fail(new SubagentRuntimeClosedError({ message: "Parent session shut down." }))
          : Deferred.await(changed),
    );

  return { observe, close, current, waitForChange };
}

export interface QueuedStartCheckDependencies extends Pick<
  RunContext,
  "records" | "writerPools" | "writerLeases" | "withLock"
> {
  /** Under the run lock: direct-child slots that worktree launches acquiring workspaces hold. */
  readonly heldLaunchSlots: (caller: string) => HeldLaunchSlots;
  /** Under the run lock: whether the owned start that reserved `runId` holds a launch slot. */
  readonly launchSlotHeldBy: (runId: string) => boolean;
  /** Completes the request's nesting policy from the session, as an owned start does. */
  readonly withSessionNesting: (
    request: StartSubagentRequest,
  ) => Effect.Effect<StartSubagentRequest>;
}

/** What a shared-checkout writer's start is checked against for conflicts. */
interface SharedWriterTarget {
  readonly cwd: CanonicalWriterCwd;
  /** Normalized claims; absent for an exclusive writer. */
  readonly claims: ReadonlyArray<string> | undefined;
}

/** The target of a shared-checkout writer, or none for other starts. */
const sharedWriterTarget = (
  dependencies: QueuedStartCheckDependencies,
  request: StartSubagentRequest,
): Effect.Effect<Option.Option<SharedWriterTarget>> => {
  // A worktree writer works in a cwd of its own, so the source's writers can't block it.
  if (request.writeIntent !== "writer" || request.writerWorkspaceModeOverride === "worktree")
    return Effect.succeedNone;
  const claims = request.writes === undefined ? undefined : normalizeWriteClaims(request.writes);
  // A request the full start would reject isn't blocked; the retry reports why.
  if (claims?.ok === false) return Effect.succeedNone;
  return dependencies.writerLeases.canonicalize(request.cwd).pipe(
    Effect.map((cwd) => Option.some({ cwd, claims: claims?.claims })),
    Effect.orElseSucceed(() => Option.none()),
  );
};

/**
 * Cheap checks for queued workflow starts, without their validation, backend resolution or
 * preflight, so a waiter tries a full start only when it could be admitted. They must never
 * report a start blocked that the full start would admit: everything they count is a holding
 * whose release advances the admission revision, and a writer conflict counts only while it
 * clears by itself.
 */
export const makeQueuedStartChecks = (dependencies: QueuedStartCheckDependencies) => {
  const { records, writerPools, withLock, heldLaunchSlots, launchSlotHeldBy } = dependencies;

  /**
   * Under the run lock: whether the owned start that reserved `runId` already counts here
   * through its launch slot, its eviction claim or its admitted run, which needs no slot once
   * it has ended.
   */
  const alreadyCounted = (runId: string): boolean =>
    records.has(runId) ||
    launchSlotHeldBy(runId) ||
    [...records.values()].some((record) => record.evictionClaim?.runId === runId);

  /**
   * How many of `requests`, from the front, the parent could admit now as workflow agents,
   * beside the starts already let through, named by their reserved run ids. Those that hold no
   * slot of their own yet count as workflow agents, so no start counts twice, as do workflow
   * worktree launches still acquiring their workspaces, exactly as the full start counts them.
   * Every workflow start is a root child, so each admitted one counts against the next.
   */
  const admissible = (
    requests: ReadonlyArray<StartSubagentRequest>,
    letThrough: ReadonlyArray<string>,
  ): Effect.Effect<number> =>
    Effect.forEach(requests, dependencies.withSessionNesting).pipe(
      Effect.flatMap((completed) =>
        withLock(
          Effect.sync(() => {
            const pending = letThrough.filter((runId) => !alreadyCounted(runId)).length;
            let admitted = 0;
            for (const request of completed) {
              const parentRunId = request.parentRunId ?? SUBAGENT_ROOT_RUN_ID;
              const limit = (request.nestingPolicy ?? DEFAULT_SUBAGENT_NESTING_POLICY)
                .maxDirectChildren;
              const refused = workflowCapacityError(
                records,
                parentRunId,
                limit,
                undefined,
                heldLaunchSlots(parentRunId),
                pending + admitted,
              );
              if (refused) break;
              admitted += 1;
            }
            return admitted;
          }),
        ),
      ),
    );

  /** The writer a shared-checkout writer still conflicts with, while that clears by itself. */
  const writerConflict = (
    request: StartSubagentRequest,
  ): Effect.Effect<SubagentWriterConflictError | undefined> =>
    sharedWriterTarget(dependencies, request).pipe(
      Effect.flatMap((writer) =>
        Option.isNone(writer)
          ? Effect.succeed(undefined)
          : withLock(
              Effect.sync(() => {
                const { cwd, claims } = writer.value;
                const conflict = writerConflictError(records, writerPools, cwd, claims);
                return conflict?.transient === true ? conflict : undefined;
              }),
            ),
      ),
    );

  return { admissible, writerConflict };
};
