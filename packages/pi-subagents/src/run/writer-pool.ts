import type * as Deferred from "effect/Deferred";
import type * as Scope from "effect/Scope";
import type { CanonicalWriterCwd, WriterLease } from "../boundary/writer-lease.ts";
import type { SubagentError } from "./errors.ts";

export type WriterPoolState =
  | "pending"
  | "preparing"
  | "held"
  | "failed"
  | "releasing"
  | "paused"
  | "quarantined";

/**
 * One parent session owns at most one cross-process lease per canonical cwd.
 * Every field is mutated under SubagentService's shared lock, except the
 * release authorization flag consumed by the lease-scope finalizer.
 */
export interface WriterPoolEntry {
  readonly cwd: CanonicalWriterCwd;
  readonly leaseScope: Scope.Closeable;
  readonly releaseState: { authorized: boolean };
  readonly preparationSettled: Deferred.Deferred<void, SubagentError>;
  readonly members: Map<string, ReadonlyArray<string> | undefined>;
  readonly violationRunIds: Set<string>;
  state: WriterPoolState;
  lease?: WriterLease | undefined;
  preparationError?: SubagentError | undefined;
  admissionPaused: boolean;
  pauseReason?: string | undefined;
}

export const writerPoolUnavailable = (pool: WriterPoolEntry | undefined): boolean =>
  pool?.state === "failed" ||
  pool?.state === "quarantined" ||
  pool?.state === "releasing" ||
  pool?.state === "paused" ||
  pool?.admissionPaused === true;
