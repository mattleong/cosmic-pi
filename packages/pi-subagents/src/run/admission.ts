import type { CanonicalWriterCwd } from "../boundary/writer-lease.ts";
import { SubagentCapacityError, SubagentWriterConflictError } from "./errors.ts";
import type { RunRecord } from "./internal.ts";
import { MAX_CONCURRENT_RUNS } from "./limits.ts";
import { isActiveRunState } from "./model.ts";

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
  canonicalCwd: CanonicalWriterCwd,
  excluded?: RunRecord,
): SubagentWriterConflictError | undefined => {
  const conflictingRecord = [...records.values()].find(
    (record) =>
      record !== excluded &&
      ((ownsWriterSlot(record) && record.canonicalWriterCwd?.digest === canonicalCwd.digest) ||
        record.evictionClaim?.writerCwdDigest === canonicalCwd.digest),
  );
  if (!conflictingRecord) return undefined;
  const reserved = conflictingRecord.evictionClaim?.writerCwdDigest === canonicalCwd.digest;
  return new SubagentWriterConflictError({
    activeId: conflictingRecord.view.id,
    activeName: conflictingRecord.view.name,
    message: reserved
      ? `Writer start admission for the shared cwd is already reserved while subagent history is reclaimed.`
      : conflictingRecord.cleanupPending
        ? `Writer ${conflictingRecord.view.name} (${conflictingRecord.view.id}) remains quarantined because cleanup could not be confirmed.`
        : `Writer ${conflictingRecord.view.name} (${conflictingRecord.view.id}) already owns the shared cwd.`,
  });
};
