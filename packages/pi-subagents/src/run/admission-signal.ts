import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { CanonicalWriterCwd } from "../boundary/writer-lease.ts";
import { DEFAULT_SUBAGENT_NESTING_POLICY } from "../config/schema.ts";
import { normalizeWriteClaims } from "../domain/write-claims.ts";
import { admissionHoldings, processCapacityError, writerConflictError } from "./admission.ts";
import { SubagentRuntimeClosedError } from "./errors.ts";
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

/** What refused a queued start: the parent's direct-child capacity, or a writer conflict. */
export type QueuedStartRefusal = "capacity" | "writer_conflict";

export interface QueuedStartCheckDependencies extends Pick<
  RunContext,
  "records" | "writerPools" | "writerLeases" | "withLock"
> {
  /** Under the run lock: direct-child slots that worktree launches acquiring workspaces hold. */
  readonly heldLaunchSlots: (caller: string) => number;
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
 * Checks whether a queued start's refusal still stands without its validation, backend
 * resolution or preflight, so a release wakes every waiter cheaply. It must never report a
 * start blocked that the full start would admit: everything it counts is a holding whose
 * release advances the admission revision, and a writer conflict counts only while it clears
 * by itself.
 */
export const makeQueuedStartCheck =
  (dependencies: QueuedStartCheckDependencies) =>
  (request: StartSubagentRequest, refusal: QueuedStartRefusal): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      const { records, writerPools, withLock, heldLaunchSlots } = dependencies;
      const complete = yield* dependencies.withSessionNesting(request);
      const writer =
        refusal === "writer_conflict"
          ? yield* sharedWriterTarget(dependencies, complete)
          : Option.none();
      const parentRunId = complete.parentRunId ?? SUBAGENT_ROOT_RUN_ID;
      const limit = (complete.nestingPolicy ?? DEFAULT_SUBAGENT_NESTING_POLICY).maxDirectChildren;
      return yield* withLock(
        Effect.sync(
          () =>
            processCapacityError(
              records,
              parentRunId,
              limit,
              undefined,
              heldLaunchSlots(parentRunId),
            ) !== undefined ||
            Option.exists(
              writer,
              (target) =>
                writerConflictError(records, writerPools, target.cwd, target.claims)?.transient ===
                true,
            ),
        ),
      );
    });
