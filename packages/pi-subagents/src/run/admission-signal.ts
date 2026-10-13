import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { normalizeWriteClaims } from "../domain/write-claims.ts";
import { writerConflictError, writerConflictHoldings } from "./admission.ts";
import { SubagentRuntimeClosedError, type SubagentWriterConflictError } from "./errors.ts";
import type { RunContext, RunRecord } from "./internal.ts";
import type { StartSubagentRequest } from "./model.ts";
import type { WriterPoolLookup } from "./writer-pool.ts";

export function makeRunAdmissionSignal(
  records: ReadonlyMap<string, RunRecord>,
  writerPools: WriterPoolLookup,
) {
  let revision = 0;
  const snapshot = (): ReadonlySet<string> => writerConflictHoldings(records, writerPools);
  let holdings = snapshot();
  let changed = Deferred.makeUnsafe<void, SubagentRuntimeClosedError>();
  let closed = false;

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
    Effect.suspend(() => (revision > after ? Effect.void : Deferred.await(changed)));

  return { observe, close, current, waitForChange };
}

export const makeQueuedWriterCheck =
  ({
    records,
    writerPools,
    writerLeases,
    withLock,
  }: Pick<RunContext, "records" | "writerLeases" | "withLock"> & {
    readonly writerPools: WriterPoolLookup;
  }) =>
  (request: StartSubagentRequest): Effect.Effect<SubagentWriterConflictError | undefined> =>
    Effect.gen(function* () {
      if (request.writeIntent !== "writer" || request.writerWorkspaceModeOverride === "worktree")
        return undefined;
      const claims =
        request.writes === undefined ? undefined : normalizeWriteClaims(request.writes);
      if (claims?.ok === false) return undefined;
      const cwd = yield* writerLeases.canonicalize(request.cwd).pipe(Effect.option);
      if (Option.isNone(cwd)) return undefined;
      return yield* withLock(
        Effect.sync(() => {
          const conflict = writerConflictError(records, writerPools, cwd.value, claims?.claims);
          return conflict?.transient === true ? conflict : undefined;
        }),
      );
    });
