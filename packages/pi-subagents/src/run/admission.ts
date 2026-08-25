import type { CanonicalWriterCwd } from "../boundary/writer-lease.ts";
import { firstWriteClaimConflict } from "../domain/write-claims.ts";
import { SubagentCapacityError, SubagentWriterConflictError } from "./errors.ts";
import type { RunRecord } from "./internal.ts";
import { MAX_CONCURRENT_RUNS } from "./limits.ts";
import { isActiveRunState } from "./model.ts";
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
  excluded?: RunRecord,
): SubagentCapacityError | undefined => {
  const candidates = [...records.values()].filter((record) => record !== excluded);
  if (candidates.filter(ownsProcessSlot).length < MAX_CONCURRENT_RUNS) return undefined;
  const cleanupCount = candidates.filter((record) => record.cleanupPending).length;
  return new SubagentCapacityError({
    limit: MAX_CONCURRENT_RUNS,
    message:
      cleanupCount > 0
        ? `Subagent capacity is temporarily occupied while ${cleanupCount} run${cleanupCount === 1 ? "" : "s"} finish cleanup; retry shortly.`
        : `Subagent capacity reached (${MAX_CONCURRENT_RUNS}). Stop an active run first.`,
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
      message:
        pool?.state === "quarantined"
          ? "Shared-cwd writer ownership remains quarantined because cleanup could not be confirmed."
          : pool?.state === "failed"
            ? "Shared-cwd writer-pool preparation failed and existing members are still cleaning up; retry shortly."
            : pool?.state === "releasing"
              ? "Shared-cwd writer ownership is still being released; retry shortly."
              : `New writers are paused for this cwd after a write-claim violation.${pool?.pauseReason ? ` ${pool.pauseReason}` : ""}`,
    });
  }

  const conflictingRecord = [...records.values()].find((record) => {
    if (record === excluded || record === additionallyExcluded) return false;
    if (record.evictionClaim?.writerCwdDigest === canonicalCwd.digest) {
      return firstWriteClaimConflict(writeClaims, record.evictionClaim.writeClaims) !== undefined;
    }
    if (record.canonicalWriterCwd?.digest !== canonicalCwd.digest) return false;
    if (record.retryClaim)
      return firstWriteClaimConflict(writeClaims, record.view.writeClaims) !== undefined;
    if (!ownsWriterSlot(record)) return false;
    if (record.cleanupPending) return true;
    return firstWriteClaimConflict(writeClaims, record.view.writeClaims) !== undefined;
  });
  if (!conflictingRecord) return undefined;
  const evictionReserved = conflictingRecord.evictionClaim?.writerCwdDigest === canonicalCwd.digest;
  const retryReserved = conflictingRecord.retryClaim !== undefined;
  const conflict = firstWriteClaimConflict(
    writeClaims,
    evictionReserved
      ? conflictingRecord.evictionClaim?.writeClaims
      : conflictingRecord.view.writeClaims,
  );
  return new SubagentWriterConflictError({
    activeId: conflictingRecord.view.id,
    activeName: conflictingRecord.view.name,
    message: evictionReserved
      ? "Overlapping writer start admission is already reserved while subagent history is reclaimed."
      : retryReserved
        ? `Writer ${conflictingRecord.view.name} (${conflictingRecord.view.id}) reserves overlapping claims for an explicit route retry.`
        : conflictingRecord.cleanupPending
          ? `Writer ${conflictingRecord.view.name} (${conflictingRecord.view.id}) remains quarantined because cleanup could not be confirmed.`
          : conflict?.left === "<exclusive>" || conflict?.right === "<exclusive>"
            ? `Writer ${conflictingRecord.view.name} (${conflictingRecord.view.id}) owns the shared cwd exclusively.`
            : `Writer ${conflictingRecord.view.name} (${conflictingRecord.view.id}) already claims ${conflict?.right ?? "the requested file"}.`,
  });
};
