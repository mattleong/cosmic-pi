import type { CanonicalWriterCwd } from "../boundary/writer-lease.ts";
import { firstWriteClaimConflict } from "../domain/write-claims.ts";
import { SubagentCapacityError, SubagentWriterConflictError } from "./errors.ts";
import type { RunRecord } from "./internal.ts";
import { isActiveRunState, SUBAGENT_ROOT_RUN_ID } from "./model.ts";
import type { WriterPoolEntry } from "./writer-pool.ts";
import { writerPoolUnavailable } from "./writer-pool.ts";

const ownsProcessSlot = (record: RunRecord): boolean =>
  record.cleanupPending ||
  record.process !== undefined ||
  record.view.state === "starting" ||
  record.evictionClaim !== undefined;

const ownsWriterSlot = (record: RunRecord): boolean =>
  record.view.writeIntent === "writer" &&
  (record.cleanupPending || isActiveRunState(record.view.state));

export const processCapacityError = (
  records: ReadonlyMap<string, RunRecord>,
  parentRunId: string,
  limit: number,
  excluded?: RunRecord,
): SubagentCapacityError | undefined => {
  const candidates = [...records.values()].filter((record) => record !== excluded);
  const occupiedChildren = candidates.filter(
    (record) =>
      (record.view.parentRunId ?? SUBAGENT_ROOT_RUN_ID) === parentRunId && ownsProcessSlot(record),
  ).length;
  const externalReservations = candidates.filter(
    (record) =>
      (record.view.parentRunId ?? SUBAGENT_ROOT_RUN_ID) !== parentRunId &&
      record.evictionClaim?.parentRunId === parentRunId,
  ).length;
  if (occupiedChildren + externalReservations < limit) return undefined;
  return new SubagentCapacityError({
    limit,
    code: "direct_child_capacity",
    message: `Direct-child capacity reached for ${parentRunId} (${limit}). Stop an active run among this parent's direct children first.`,
  });
};

export const writerConflictError = (
  records: ReadonlyMap<string, RunRecord>,
  pools: ReadonlyMap<string, WriterPoolEntry>,
  canonicalCwd: CanonicalWriterCwd,
  writeClaims: ReadonlyArray<string> | undefined,
  excluded?: RunRecord,
  additionallyExcluded?: RunRecord,
): SubagentWriterConflictError | undefined => {
  const pool = pools.get(canonicalCwd.digest);
  if (writerPoolUnavailable(pool)) {
    const activeId =
      pool?.members.keys().next().value ?? pool?.violationRunIds.values().next().value;
    const active = activeId ? records.get(activeId) : undefined;
    return new SubagentWriterConflictError({
      activeId: active?.view.id ?? "shared-writer-pool",
      activeName: active?.view.name ?? "shared writer pool",
      message: writerPoolUnavailableMessage(pool),
    });
  }

  for (const record of records.values()) {
    if (record === excluded || record === additionallyExcluded) continue;
    const message = writerConflictMessage(record, canonicalCwd, writeClaims);
    if (message === undefined) continue;
    return new SubagentWriterConflictError({
      activeId: record.view.id,
      activeName: record.view.name,
      message,
    });
  }
  return undefined;
};

const writerPoolUnavailableMessage = (pool: WriterPoolEntry | undefined): string => {
  switch (pool?.state) {
    case "quarantined":
      return "Shared-cwd writer ownership remains quarantined because cleanup could not be confirmed.";
    case "failed":
      return "Shared-cwd writer-pool preparation failed and existing members are still cleaning up; retry shortly.";
    case "releasing":
      return "Shared-cwd writer ownership is still being released; retry shortly.";
    default:
      return `New writers are paused for this cwd after a write-claim violation.${pool?.pauseReason ? ` ${pool.pauseReason}` : ""}`;
  }
};

/** Why one record blocks a writer start on the same canonical cwd, or undefined when it does not. */
const writerConflictMessage = (
  record: RunRecord,
  canonicalCwd: CanonicalWriterCwd,
  writeClaims: ReadonlyArray<string> | undefined,
): string | undefined => {
  if (record.evictionClaim?.writerCwdDigest === canonicalCwd.digest)
    return (
      firstWriteClaimConflict(writeClaims, record.evictionClaim.writeClaims) &&
      "Overlapping writer start admission is already reserved while subagent history is reclaimed."
    );
  if (record.canonicalWriterCwd?.digest !== canonicalCwd.digest) return undefined;
  const writer = `Writer ${record.view.name} (${record.view.id})`;
  if (record.retryClaim)
    return (
      firstWriteClaimConflict(writeClaims, record.view.writeClaims) &&
      `${writer} reserves overlapping claims for an explicit route retry.`
    );
  if (!ownsWriterSlot(record)) return undefined;
  if (record.cleanupPending)
    return `${writer} remains quarantined because cleanup could not be confirmed.`;
  const conflict = firstWriteClaimConflict(writeClaims, record.view.writeClaims);
  if (conflict === undefined) return undefined;
  return conflict.left === "<exclusive>" || conflict.right === "<exclusive>"
    ? `${writer} owns the shared cwd exclusively.`
    : `${writer} already claims ${conflict.right ?? "the requested file"}.`;
};
