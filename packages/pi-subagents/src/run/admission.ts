import { absurd } from "effect/Function";
import * as Effect from "effect/Effect";
import type { CanonicalWriterCwd, WriterLeaseContract } from "../boundary/writer-lease.ts";
import { firstWriteClaimConflict } from "../domain/write-claims.ts";
import { invalidRequest, SubagentCapacityError, SubagentWriterConflictError } from "./errors.ts";
import type { RunRecord } from "./internal.ts";
import { isActiveRunState, SUBAGENT_ROOT_RUN_ID } from "./model.ts";
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
  record.cleanupPending ||
  record.process !== undefined ||
  record.view.state === "starting" ||
  record.evictionClaim !== undefined;

const ownsWriterSlot = (record: RunRecord): boolean =>
  record.view.writeIntent === "writer" &&
  (record.cleanupPending || isActiveRunState(record.view.state));

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
  const occupied = [...records.values()].filter(
    (record) => record !== excluded && holdsChildSlot(record, parentRunId),
  ).length;
  if (occupied + held < limit) return undefined;
  return new SubagentCapacityError({
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
  const occupied = [...records.values()].filter(
    (record) => record !== excluded && ownsProcessSlot(record),
  ).length;
  if (occupied + held < limit) return undefined;
  return new SubagentCapacityError({
    limit,
    code: "tree_capacity",
    message: `Active subagent limit reached (${limit}). Wait for a run to finish or stop one first; nesting.maxActiveRuns sets the limit.`,
  });
};

export const writerConflictError = (
  records: ReadonlyMap<string, RunRecord>,
  pools: WriterPoolLookup,
  canonicalCwd: CanonicalWriterCwd,
  writeClaims: ReadonlyArray<string> | undefined,
  excluded?: RunRecord,
  additionallyExcluded?: RunRecord,
): SubagentWriterConflictError | undefined => {
  const pool = pools.get(canonicalCwd.digest);
  const unavailable = pool === undefined ? undefined : writerPoolUnavailableConflict(pool);
  if (pool && unavailable) {
    const activeId = pool.members.keys().next().value;
    const active = activeId ? records.get(activeId) : undefined;
    return new SubagentWriterConflictError({
      activeId: active?.view.id ?? "shared-writer-pool",
      activeName: active?.view.name ?? "shared writer pool",
      ...unavailable,
    });
  }

  for (const record of records.values()) {
    if (record === excluded || record === additionallyExcluded) continue;
    const conflict = writerConflict(record, canonicalCwd, writeClaims);
    if (conflict === undefined) continue;
    return new SubagentWriterConflictError({
      activeId: record.view.id,
      activeName: record.view.name,
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
  return absurd(pool.state);
};

interface WriterConflict {
  readonly message: string;
  readonly transient: boolean;
}

const writerConflict = (
  record: RunRecord,
  canonicalCwd: CanonicalWriterCwd,
  writeClaims: ReadonlyArray<string> | undefined,
): WriterConflict | undefined => {
  if (record.evictionClaim?.writerCwdDigest === canonicalCwd.digest)
    return firstWriteClaimConflict(writeClaims, record.evictionClaim.writeClaims)
      ? {
          message:
            "Overlapping writer start admission is already reserved while subagent history is reclaimed.",
          transient: true,
        }
      : undefined;
  if (record.canonicalWriterCwd?.digest !== canonicalCwd.digest) return undefined;
  const writer = `Writer ${record.view.name} (${record.view.id})`;
  if (record.retryClaim)
    return firstWriteClaimConflict(writeClaims, record.view.writeClaims)
      ? {
          message: `${writer} reserves overlapping claims for an explicit route retry.`,
          transient: true,
        }
      : undefined;
  if (!ownsWriterSlot(record)) return undefined;
  if (record.cleanupPending)
    return record.cleanupDisposition === "quarantined"
      ? {
          message: `${writer} remains quarantined because cleanup could not be confirmed.`,
          transient: false,
        }
      : { message: `${writer} is still cleaning up; retry shortly.`, transient: true };
  const conflict = firstWriteClaimConflict(writeClaims, record.view.writeClaims);
  if (conflict === undefined) return undefined;
  return {
    message:
      conflict.left === "<exclusive>" || conflict.right === "<exclusive>"
        ? `${writer} owns the shared cwd exclusively.`
        : `${writer} already claims ${conflict.right ?? "the requested file"}.`,
    transient: true,
  };
};
