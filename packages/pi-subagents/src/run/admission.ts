import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Effect from "effect/Effect";
import type { CanonicalWriterCwd, WriterLeaseContract } from "../boundary/writer-lease.ts";
import { invalidRequest, SubagentCapacityError, SubagentWriterConflictError } from "./errors.ts";
import { isCleanupOwed, type RunRecord } from "./internal.ts";
import { SUBAGENT_ROOT_RUN_ID } from "./model.ts";
import type { WriterPoolView, WriterPoolLookup } from "./writer-pool.ts";

export const canonicalizeWriterCwd = (writerLeases: WriterLeaseContract, cwd: string) =>
  writerLeases
    .canonicalize(cwd)
    .pipe(
      Effect.mapError((error) =>
        invalidRequest("writer_cwd_canonicalization_failed", error.message),
      ),
    );

const ownsProcessSlot = (record: RunRecord): boolean =>
  isCleanupOwed(record) ||
  record.process !== undefined ||
  record.view.state === "starting" ||
  record.evictionClaim !== undefined;

const holdsChildSlot = (record: RunRecord, parentRunId: string): boolean => {
  const claim = record.evictionClaim;
  if (claim) return claim.parentRunId === parentRunId;
  return (
    (record.view.parentRunId ?? SUBAGENT_ROOT_RUN_ID) === parentRunId && ownsProcessSlot(record)
  );
};

export const processCapacityError = (
  records: ReadonlyMap<string, RunRecord>,
  parentRunId: string,
  limit: number,
  excluded?: RunRecord,
  held = 0,
): SubagentCapacityError | undefined => {
  const occupied = Arr.filter(
    [...records.values()],
    (record) => record !== excluded && holdsChildSlot(record, parentRunId),
  ).length;
  if (occupied + held < limit) return undefined;
  return SubagentCapacityError.make({
    limit,
    code: "direct_child_capacity",
    message: `Direct-child capacity reached for ${parentRunId} (${limit}). Stop an active run among this parent's direct children first.`,
  });
};

/** Caps active subagent processes across the whole tree, whatever their parent. */
export const treeCapacityError = (
  records: ReadonlyMap<string, RunRecord>,
  limit: number,
  excluded?: RunRecord,
  held = 0,
): SubagentCapacityError | undefined => {
  const occupied = Arr.filter(
    [...records.values()],
    (record) => record !== excluded && ownsProcessSlot(record),
  ).length;
  if (occupied + held < limit) return undefined;
  return SubagentCapacityError.make({
    limit,
    code: "tree_capacity",
    message: `Active subagent limit reached (${limit}). Wait for a run to finish or stop one first; nesting.maxActiveRuns sets the limit.`,
  });
};

export const writerConflictError = (
  records: ReadonlyMap<string, RunRecord>,
  pools: WriterPoolLookup,
  canonicalCwd: CanonicalWriterCwd,
  excluded?: RunRecord,
): SubagentWriterConflictError | undefined => {
  const pool = pools.get(canonicalCwd.digest);
  const unavailable = pool === undefined ? undefined : writerPoolUnavailableConflict(pool);
  if (pool && unavailable) {
    const activeId = pool.members.keys().next().value;
    const active = activeId ? records.get(activeId) : undefined;
    return SubagentWriterConflictError.make({
      activeId: active?.view.id ?? "shared-writer-pool",
      activeName: active?.launch.name ?? "shared writer pool",
      ...unavailable,
    });
  }

  for (const record of records.values()) {
    if (record === excluded) continue;
    const conflict = writerConflict(record, canonicalCwd);
    if (conflict === undefined) continue;
    return SubagentWriterConflictError.make({
      activeId: record.view.id,
      activeName: record.launch.name,
      ...conflict,
    });
  }
  return undefined;
};

const writerPoolUnavailableConflict = (pool: WriterPoolView): WriterConflict | undefined => {
  switch (pool.state) {
    case "quarantined":
      return {
        message:
          "Shared-cwd writer ownership remains quarantined because cleanup could not be confirmed.",
        transient: false,
      };
    case "failed":
      return {
        message:
          "Shared-cwd writer-pool preparation failed and existing members are still cleaning up; retry shortly.",
        transient: true,
      };
    case "releasing":
      return {
        message: "Shared-cwd writer ownership is still being released; retry shortly.",
        transient: true,
      };
    case "held":
    case "pending":
    case "preparing":
      return undefined;
  }
  return Fn.absurd(pool.state);
};

interface WriterConflict {
  readonly message: string;
  readonly transient: boolean;
}

// Any number of in-process writers share a pool; only a member whose cleanup is still
// unconfirmed keeps new writers out of its cwd.
const writerConflict = (
  record: RunRecord,
  canonicalCwd: CanonicalWriterCwd,
): WriterConflict | undefined => {
  if (record.canonicalWriterCwd?.digest !== canonicalCwd.digest) return undefined;
  if (!isCleanupOwed(record) || record.view.writeIntent !== "writer") return undefined;
  const writer = `Writer ${record.launch.name} (${record.view.id})`;
  return record.cleanupDisposition === "quarantined"
    ? {
        message: `${writer} remains quarantined because cleanup could not be confirmed.`,
        transient: false,
      }
    : { message: `${writer} is still cleaning up; retry shortly.`, transient: true };
};
