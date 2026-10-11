import * as Effect from "effect/Effect";
import type { CanonicalWriterCwd, WriterLeaseContract } from "../boundary/writer-lease.ts";
import { firstWriteClaimConflict } from "../domain/write-claims.ts";
import { invalidRequest, SubagentCapacityError, SubagentWriterConflictError } from "./errors.ts";
import type { RunRecord } from "./internal.ts";
import { isActiveRunState, SUBAGENT_ROOT_RUN_ID } from "./model.ts";
import type { WriterPoolEntry } from "./writer-pool.ts";
import { writerPoolUnavailable } from "./writer-pool.ts";

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

export const workflowOwned = (record: RunRecord): boolean =>
  record.view.workflow !== undefined && record.owner?.live === true;

const holdsChildSlot = (record: RunRecord, parentRunId: string): boolean => {
  const claim = record.evictionClaim;
  if (claim) return claim.parentRunId === parentRunId;
  return (
    (record.view.parentRunId ?? SUBAGENT_ROOT_RUN_ID) === parentRunId &&
    !workflowOwned(record) &&
    ownsProcessSlot(record)
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
      transient: writerPoolSettlesAlone(pool),
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

const writerPoolSettlesAlone = (pool: WriterPoolEntry | undefined): boolean =>
  pool?.admissionPaused !== true && (pool?.state === "releasing" || pool?.state === "failed");

const writerPoolUnavailableMessage = (pool: WriterPoolEntry | undefined): string => {
  switch (pool?.state) {
    case "quarantined":
      return "Shared-cwd writer ownership remains quarantined because cleanup could not be confirmed.";
    case "failed":
      return "Shared-cwd writer-pool preparation failed and existing members are still cleaning up; retry shortly.";
    case "releasing":
      return "Shared-cwd writer ownership is still being released; retry shortly.";
    case undefined:
    case "held":
    case "paused":
    case "pending":
    case "preparing":
      return `New writers are paused for this cwd after a write-claim violation.${pool?.pauseReason ? ` ${pool.pauseReason}` : ""}`;
  }
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

const claimHoldings = (record: RunRecord): ReadonlyArray<string> =>
  ownsWriterSlot(record) || record.retryClaim
    ? (record.view.writeClaims ?? ["<exclusive>"]).map(
        (claim) => `claim:${record.view.id}:${claim}`,
      )
    : [];

export const writerConflictHoldings = (
  records: ReadonlyMap<string, RunRecord>,
  pools: ReadonlyMap<string, WriterPoolEntry>,
): ReadonlySet<string> => {
  const holdings = new Set<string>();
  for (const record of records.values()) {
    const id = record.view.id;
    if (ownsWriterSlot(record)) holdings.add(`writer:${id}`);
    for (const claim of claimHoldings(record)) holdings.add(claim);
    if (record.cleanupPending && record.cleanupDisposition !== "quarantined")
      holdings.add(`cleanup:${id}`);
    if (record.retryClaim) holdings.add(`retry:${id}`);
    if (record.evictionClaim) holdings.add(`eviction:${id}`);
  }
  for (const [digest, pool] of pools)
    if (writerPoolUnavailable(pool)) holdings.add(`pool:${digest}:${pool.state}`);
  return holdings;
};
