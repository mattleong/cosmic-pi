import * as Effect from "effect/Effect";
import type { CanonicalWriterCwd, WriterLeaseContract } from "../boundary/writer-lease.ts";
import { firstWriteClaimConflict } from "../domain/write-claims.ts";
import { invalidRequest, SubagentCapacityError, SubagentWriterConflictError } from "./errors.ts";
import type { RunRecord } from "./internal.ts";
import { isActiveRunState, SUBAGENT_ROOT_RUN_ID } from "./model.ts";
import type { WriterPoolEntry } from "./writer-pool.ts";
import { writerPoolUnavailable } from "./writer-pool.ts";

/** Canonicalizes a writer cwd; failure rejects the request rather than the backend. */
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

export const processCapacityError = (
  records: ReadonlyMap<string, RunRecord>,
  parentRunId: string,
  limit: number,
  excluded?: RunRecord,
  /** Slots that launches still acquiring workspaces hold for this parent. */
  held = 0,
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
  if (occupiedChildren + externalReservations + held < limit) return undefined;
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

/** A releasing pool, or a failed one whose members are still leaving, clears without help. */
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
    default:
      return `New writers are paused for this cwd after a write-claim violation.${pool?.pauseReason ? ` ${pool.pauseReason}` : ""}`;
  }
};

interface WriterConflict {
  readonly message: string;
  readonly transient: boolean;
}

/** Why one record blocks a writer start on the same canonical cwd, or undefined when it does not. */
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

/** Each file a writer's slot or retry reservation claims, or the whole cwd when exclusive. */
const claimHoldings = (record: RunRecord): ReadonlyArray<string> =>
  ownsWriterSlot(record) || record.retryClaim
    ? (record.view.writeClaims ?? ["<exclusive>"]).map(
        (claim) => `claim:${record.view.id}:${claim}`,
      )
    : [];

/**
 * Everything that can refuse a start: process and writer slots, the files a writer claims,
 * cleanup still under way, retry and eviction reservations, and unavailable writer pools. A
 * start refused for any of them can only succeed after one of these holdings disappears, so
 * narrowing a writer's claims counts as a release while widening them does not.
 */
export const admissionHoldings = (
  records: ReadonlyMap<string, RunRecord>,
  pools: ReadonlyMap<string, WriterPoolEntry>,
): ReadonlySet<string> => {
  const holdings = new Set<string>();
  for (const record of records.values()) {
    const id = record.view.id;
    if (ownsProcessSlot(record)) holdings.add(`process:${id}`);
    if (ownsWriterSlot(record)) holdings.add(`writer:${id}`);
    for (const claim of claimHoldings(record)) holdings.add(claim);
    // Quarantine ends this holding too, so waiters learn the conflict will not clear.
    if (record.cleanupPending && record.cleanupDisposition !== "quarantined")
      holdings.add(`cleanup:${id}`);
    if (record.retryClaim) holdings.add(`retry:${id}`);
    if (record.evictionClaim) holdings.add(`eviction:${id}`);
  }
  for (const [digest, pool] of pools)
    if (writerPoolUnavailable(pool)) holdings.add(`pool:${digest}:${pool.state}`);
  return holdings;
};
