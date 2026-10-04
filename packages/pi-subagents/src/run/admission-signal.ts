import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { CanonicalWriterCwd } from "../boundary/writer-lease.ts";
import { normalizeWriteClaims } from "../domain/write-claims.ts";
import { writerConflictError, writerConflictHoldings } from "./admission.ts";
import { SubagentRuntimeClosedError, type SubagentWriterConflictError } from "./errors.ts";
import type { RunContext, RunRecord } from "./internal.ts";
import type { StartSubagentRequest } from "./model.ts";
import type { WriterPoolEntry } from "./writer-pool.ts";

/**
 * A revision that advances only when a holding that can end a writer conflict is released, so a
 * queued workflow writer rechecks its conflict when it could succeed, not on every progress
 * event. Every method is synchronous over the service's records.
 */
export function makeRunAdmissionSignal(
  records: ReadonlyMap<string, RunRecord>,
  writerPools: ReadonlyMap<string, WriterPoolEntry>,
) {
  let revision = 0;
  const snapshot = (): ReadonlySet<string> => writerConflictHoldings(records, writerPools);
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

export type QueuedWriterCheckDependencies = Pick<
  RunContext,
  "records" | "writerPools" | "writerLeases" | "withLock"
>;

/** What a shared-checkout writer's start is checked against for conflicts. */
interface SharedWriterTarget {
  readonly cwd: CanonicalWriterCwd;
  /** Normalized claims; absent for an exclusive writer. */
  readonly claims: ReadonlyArray<string> | undefined;
}

/** The target of a shared-checkout writer, or none for other starts. */
const sharedWriterTarget = (
  dependencies: QueuedWriterCheckDependencies,
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
 * The cheap check for a queued workflow writer, without validation, backend resolution or
 * preflight, so a waiter tries a full start only when no writer blocks it: the writer a
 * shared-checkout writer still conflicts with, while that clears by itself. It never reports a
 * start blocked that the full start would admit, and the conflicts it reports end with a release
 * that advances the admission revision.
 */
export const makeQueuedWriterCheck =
  (dependencies: QueuedWriterCheckDependencies) =>
  (request: StartSubagentRequest): Effect.Effect<SubagentWriterConflictError | undefined> =>
    sharedWriterTarget(dependencies, request).pipe(
      Effect.flatMap((writer) =>
        Option.isNone(writer)
          ? Effect.succeed(undefined)
          : dependencies.withLock(
              Effect.sync(() => {
                const { cwd, claims } = writer.value;
                const conflict = writerConflictError(
                  dependencies.records,
                  dependencies.writerPools,
                  cwd,
                  claims,
                );
                return conflict?.transient === true ? conflict : undefined;
              }),
            ),
      ),
    );
