import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import { currentBootTime } from "../boundary/process-liveness.ts";
import type { WorkflowRunFileError, WorkflowRunFiles } from "../boundary/workflow-run-files.ts";
import type { WorkflowRunView, WorkflowStopOrigin } from "./model.ts";
import {
  decodeWorkflowRunRecord,
  endedWorkflowRunRecord,
  notifiedWorkflowRunRecord,
  startedWorkflowRunRecord,
  workflowRunRecordText,
  type WorkflowRunRecord,
} from "./run-record.ts";
import type { WorkflowRuns } from "./runs.ts";
import { workflowServiceLog } from "./state.ts";
import type { WorkflowStoreContract } from "./store.ts";

/** A run this activation started, with the record its next write saves. */
interface TrackedRecord {
  readonly files: WorkflowRunFiles;
  record: WorkflowRunRecord;
  warned: boolean;
}

/** Keeps each run's `run.json` in step with its lifecycle; every write is best effort. */
export const makeWorkflowRunRecordWriter = Effect.fnUntraced(function* (services: {
  readonly store: Pick<WorkflowStoreContract, "writeRunRecord" | "readRunRecord">;
  readonly runs: Pick<WorkflowRuns, "recordEvent">;
  /** The Pi session id records are written under; without one nothing is written. */
  readonly sessionKey: string | undefined;
}) {
  const { store, runs, sessionKey } = services;
  const tracked = new Map<string, TrackedRecord>();
  // Writes take turns, and each saves the record as it is when its turn comes, so the last write
  // always holds the newest state whatever order changes arrive in.
  const turns = yield* Semaphore.make(1);

  /** The run logs the first failure; later writes are still tried. */
  const warnOnce = (entry: TrackedRecord, error: WorkflowRunFileError) => {
    if (entry.warned) return Effect.void;
    entry.warned = true;
    return runs.recordEvent(
      entry.record.runId,
      workflowServiceLog(
        "warning",
        `After a Pi restart this run may not be reported or resumable: ${error.message}`,
      ),
    );
  };

  const save = (entry: TrackedRecord, change: (record: WorkflowRunRecord) => WorkflowRunRecord) =>
    Effect.suspend(() => {
      entry.record = change(entry.record);
      return Effect.suspend(() =>
        store.writeRunRecord(entry.files, workflowRunRecordText(entry.record)),
      ).pipe(
        turns.withPermits(1),
        Effect.catch((error) => warnOnce(entry, error)),
      );
    });

  /** Saves a change to the record of a run this activation started; other runs have none. */
  const saveTracked = (id: string, change: (record: WorkflowRunRecord) => WorkflowRunRecord) =>
    Effect.suspend(() => {
      const entry = tracked.get(id);
      return entry ? save(entry, change) : Effect.void;
    });

  /** A run this activation didn't start: its file is updated only for this session. */
  const notifiedOnDisk = (runId: string, key: string) =>
    Effect.gen(function* () {
      const file = yield* store.readRunRecord(runId);
      const record = file && decodeWorkflowRunRecord(file.text, runId);
      if (!file || !record || record.sessionKey !== key || record.notified) return;
      const notified = workflowRunRecordText(notifiedWorkflowRunRecord(record));
      yield* store.writeRunRecord(file.files, notified).pipe(turns.withPermits(1));
    }).pipe(Effect.ignore);

  return {
    /** Writes a starting run's record; without its files or a stable session id nothing is saved. */
    create: (run: WorkflowRunView, files: WorkflowRunFiles | undefined) =>
      Effect.gen(function* () {
        if (sessionKey === undefined || files === undefined) return;
        const owner = {
          pid: process.pid,
          bootedAt: currentBootTime(yield* Clock.currentTimeMillis),
        };
        const record = startedWorkflowRunRecord(run, sessionKey, owner);
        tracked.set(run.id, { files, record, warned: false });
        yield* saveTracked(run.id, (current) => current);
      }),
    /** Notes who asked the run to stop, so a notice after a crash doesn't offer a restart. */
    noteStop: (id: string, origin: WorkflowStopOrigin) =>
      saveTracked(id, (record) => ({ ...record, stoppedBy: origin })),
    /** Records how the run ended, or `interrupted` when a teardown ended it first. */
    end: (run: WorkflowRunView, tornDown: boolean) =>
      saveTracked(run.id, (record) => endedWorkflowRunRecord(record, run, tornDown)),
    /**
     * Marks a run's notification or notice as accepted, or as needing none. A run an earlier
     * activation or Pi process started is marked in its file, when it belongs to this session.
     */
    notified: (runId: string) =>
      Effect.suspend(() => {
        if (sessionKey === undefined) return Effect.void;
        const entry = tracked.get(runId);
        if (!entry) return notifiedOnDisk(runId, sessionKey);
        // Nothing changes the record once its run is announced.
        tracked.delete(runId);
        return save(entry, notifiedWorkflowRunRecord);
      }),
  };
});
