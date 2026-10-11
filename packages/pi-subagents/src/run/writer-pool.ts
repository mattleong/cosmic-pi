import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import type { CanonicalWriterCwd, WriterLease } from "../boundary/writer-lease.ts";
import type { SubagentError } from "./errors.ts";

type WriterPoolState =
  | "pending"
  | "preparing"
  | "held"
  | "failed"
  | "releasing"
  | "paused"
  | "quarantined";

export interface WriterPoolEntry {
  readonly cwd: CanonicalWriterCwd;
  readonly leaseScope: Scope.Closeable;
  readonly releaseState: { authorized: boolean };
  readonly preparationSettled: Deferred.Deferred<void, SubagentError>;
  readonly members: Set<string>;
  readonly violationRunIds: Set<string>;
  state: WriterPoolState;
  lease?: WriterLease | undefined;
  preparationError?: SubagentError | undefined;
  admissionPaused: boolean;
  pauseReason?: string | undefined;
}

export const addWriterPoolMemberLocked = (
  pools: Map<string, WriterPoolEntry>,
  cwd: CanonicalWriterCwd,
  runId: string,
): Effect.Effect<WriterPoolEntry> =>
  Effect.gen(function* () {
    let pool = pools.get(cwd.digest);
    if (!pool) {
      pool = {
        cwd,
        leaseScope: yield* Scope.make(),
        releaseState: { authorized: false },
        preparationSettled: yield* Deferred.make<void, SubagentError>(),
        members: new Set(),
        violationRunIds: new Set(),
        state: "pending",
        admissionPaused: false,
      };
      pools.set(cwd.digest, pool);
    }
    pool.members.add(runId);
    return pool;
  });

export const writerPoolUnavailable = (pool: WriterPoolEntry | undefined): boolean =>
  pool?.state === "failed" ||
  pool?.state === "quarantined" ||
  pool?.state === "releasing" ||
  pool?.state === "paused" ||
  pool?.admissionPaused === true;
