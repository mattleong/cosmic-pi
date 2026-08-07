import type { CanonicalWriterCwd } from "../boundary/writer-lease.ts";
import { SubagentCapacityError, SubagentWriterConflictError } from "./errors.ts";
import type { RunRecord } from "./internal.ts";
import { MAX_CONCURRENT_RUNS } from "./limits.ts";
import { isActiveRunState } from "./model.ts";

const ownsProcessSlot = (record: RunRecord): boolean =>
  record.cleanupPending || record.process !== undefined || record.view.state === "starting";

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
  const activeWriter = [...records.values()].find(
    (record) =>
      record !== excluded &&
      ownsWriterSlot(record) &&
      record.canonicalWriterCwd?.digest === canonicalCwd.digest,
  );
  return activeWriter
    ? new SubagentWriterConflictError({
        activeId: activeWriter.view.id,
        activeName: activeWriter.view.name,
        message: activeWriter.cleanupPending
          ? `Writer ${activeWriter.view.name} (${activeWriter.view.id}) remains quarantined because cleanup could not be confirmed.`
          : `Writer ${activeWriter.view.name} (${activeWriter.view.id}) already owns the shared cwd.`,
      })
    : undefined;
};
