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

interface TrackedRecord {
  readonly files: WorkflowRunFiles;
  record: WorkflowRunRecord;
  warned: boolean;
}

export const makeWorkflowRunRecordWriter = Effect.fnUntraced(function* (services: {
  readonly store: Pick<WorkflowStoreContract, "writeRunRecord" | "readRunRecord">;
  readonly runs: Pick<WorkflowRuns, "recordEvent">;
  readonly sessionKey: string | undefined;
}) {
  const { store, runs, sessionKey } = services;
  const tracked = new Map<string, TrackedRecord>();
  const turns = yield* Semaphore.make(1);

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

  const saveTracked = (id: string, change: (record: WorkflowRunRecord) => WorkflowRunRecord) =>
    Effect.suspend(() => {
      const entry = tracked.get(id);
      return entry ? save(entry, change) : Effect.void;
    });

  const notifiedOnDisk = (runId: string, key: string) =>
    Effect.gen(function* () {
      const file = yield* store.readRunRecord(runId);
      const record = file && decodeWorkflowRunRecord(file.text, runId);
      if (!file || !record || record.sessionKey !== key || record.notified) return;
      const notified = workflowRunRecordText(notifiedWorkflowRunRecord(record));
      yield* store.writeRunRecord(file.files, notified).pipe(turns.withPermits(1));
    }).pipe(Effect.ignore);

  return {
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
    noteStop: (id: string, origin: WorkflowStopOrigin) =>
      saveTracked(id, (record) => ({ ...record, stoppedBy: origin })),
    end: (run: WorkflowRunView, tornDown: boolean) =>
      saveTracked(run.id, (record) => endedWorkflowRunRecord(record, run, tornDown)),
    notified: (runId: string) =>
      Effect.suspend(() => {
        if (sessionKey === undefined) return Effect.void;
        const entry = tracked.get(runId);
        if (!entry) return notifiedOnDisk(runId, sessionKey);
        tracked.delete(runId);
        return save(entry, notifiedWorkflowRunRecord);
      }),
  };
});
