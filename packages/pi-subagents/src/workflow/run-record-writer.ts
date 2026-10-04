import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import { currentBootTime, currentProcessId } from "../boundary/process-liveness.ts";
import type { WorkflowRunFileError, WorkflowRunFiles } from "../boundary/workflow-run-files.ts";
import type { WorkflowRunView, WorkflowStopOrigin } from "./model.ts";
import {
  decodeWorkflowRunRecord,
  endedWorkflowRunRecord,
  notifiedWorkflowRunRecord,
  startedWorkflowRunRecord,
  stoppingWorkflowRunRecord,
  workflowRunRecordText,
  type WorkflowRunRecord,
} from "./run-record.ts";
import type { WorkflowRuns } from "./runs.ts";
import { workflowServiceLog } from "./state.ts";
import type { WorkflowStoreContract } from "./store.ts";

/** Keeps each run's `run.json` in step with its lifecycle; every write is best effort. */
export interface WorkflowRunRecordWriter {
  /** Writes a starting run's record; without its files or a stable session id nothing is saved. */
  readonly create: (
    run: WorkflowRunView,
    files: WorkflowRunFiles | undefined,
  ) => Effect.Effect<void>;
  /** Notes who asked the run to stop. */
  readonly noteStop: (id: string, origin: WorkflowStopOrigin) => Effect.Effect<void>;
  /** Records how the run ended, or `interrupted` when a teardown ended it first. */
  readonly end: (run: WorkflowRunView, tornDown: boolean) => Effect.Effect<void>;
  /**
   * Marks a run's notification or notice as accepted, or as needing none. A run an earlier
   * activation or Pi process started is marked in its file, when it belongs to this session.
   */
  readonly notified: (runId: string) => Effect.Effect<void>;
}

export interface WorkflowRunRecordWriterServices {
  readonly store: Pick<WorkflowStoreContract, "writeRunRecord" | "readRunRecord">;
  readonly runs: Pick<WorkflowRuns, "recordEvent">;
  /** The Pi session id records are written under; without one nothing is written. */
  readonly sessionKey: string | undefined;
}

/** A run this activation started, with the record its next write saves. */
interface TrackedRecord {
  readonly files: WorkflowRunFiles;
  record: WorkflowRunRecord;
  warned: boolean;
}

export const makeWorkflowRunRecordWriter = (
  services: WorkflowRunRecordWriterServices,
): WorkflowRunRecordWriter => {
  const { store, runs, sessionKey } = services;
  const tracked = new Map<string, TrackedRecord>();
  // Writes take turns, and each saves the record as it is when its turn comes, so the last write
  // always holds the newest state whatever order changes arrive in.
  const turns = Semaphore.makeUnsafe(1);

  /** The run logs the first failure; later writes are still tried. */
  const warnOnce = (id: string, entry: TrackedRecord, error: WorkflowRunFileError) => {
    if (entry.warned) return Effect.void;
    entry.warned = true;
    return runs.recordEvent(
      id,
      workflowServiceLog(
        "warning",
        `After a Pi restart this run may not be reported or resumable: ${error.message}`,
      ),
    );
  };

  const save = (
    id: string,
    entry: TrackedRecord,
    change: (record: WorkflowRunRecord) => WorkflowRunRecord,
  ) =>
    Effect.suspend(() => {
      entry.record = change(entry.record);
      return Effect.suspend(() =>
        store.writeRunRecord(entry.files, workflowRunRecordText(entry.record)),
      ).pipe(
        turns.withPermits(1),
        Effect.catch((error) => warnOnce(id, entry, error)),
      );
    });

  const create: WorkflowRunRecordWriter["create"] = (run, files) =>
    Effect.gen(function* () {
      if (sessionKey === undefined || files === undefined) return;
      const owner = {
        pid: currentProcessId(),
        bootedAt: currentBootTime(yield* Clock.currentTimeMillis),
      };
      const entry: TrackedRecord = {
        files,
        record: startedWorkflowRunRecord(run, sessionKey, owner),
        warned: false,
      };
      tracked.set(run.id, entry);
      yield* save(run.id, entry, (current) => current);
    });

  const noteStop: WorkflowRunRecordWriter["noteStop"] = (id, origin) =>
    Effect.suspend(() => {
      const entry = tracked.get(id);
      return entry
        ? save(id, entry, (record) => stoppingWorkflowRunRecord(record, origin))
        : Effect.void;
    });

  const end: WorkflowRunRecordWriter["end"] = (run, tornDown) =>
    Effect.suspend(() => {
      const entry = tracked.get(run.id);
      return entry
        ? save(run.id, entry, (record) => endedWorkflowRunRecord(record, run, tornDown))
        : Effect.void;
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

  const notified: WorkflowRunRecordWriter["notified"] = (runId) =>
    Effect.suspend(() => {
      if (sessionKey === undefined) return Effect.void;
      const entry = tracked.get(runId);
      if (!entry) return notifiedOnDisk(runId, sessionKey);
      // Nothing changes the record once its run is announced.
      tracked.delete(runId);
      return save(runId, entry, notifiedWorkflowRunRecord);
    });

  return { create, noteStop, end, notified };
};
