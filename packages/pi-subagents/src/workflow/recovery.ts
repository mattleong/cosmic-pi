import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { currentBootTime, currentProcessId, isProcessAlive } from "../boundary/process-liveness.ts";
import type { WorkflowRunFileError, WorkflowRunFiles } from "../boundary/workflow-run-files.ts";
import { canonicalResultJson } from "../domain/result-contract.ts";
import { workflowRequestError, type WorkflowRequestError } from "./errors.ts";
import {
  makeWorkflowReplay,
  WORKFLOW_JOURNAL_MAX_CHARS,
  type WorkflowInterruptedRun,
  type WorkflowJournalEntry,
  type WorkflowReplay,
} from "./journal.ts";
import { isWorkflowRunFinished, WORKFLOW_RETAINED_RUNS } from "./model.ts";
import { readWorkflowResultLines, type WorkflowReplayLine } from "./results.ts";
import {
  decodeWorkflowRunRecord,
  isWorkflowRunLiveElsewhere,
  isWorkflowRunNoticeOwed,
  workflowRecordedRun,
  type WorkflowRecordedRun,
  type WorkflowRunLiveness,
} from "./run-record.ts";
import type { WorkflowRunRecordFile, WorkflowStoreContract } from "./store.ts";

/**
 * What this session finds in the run files of runs no longer in memory, such as those of an
 * earlier Pi process: their results for a resume, the notices still owed, and status summaries.
 * Only runs whose `run.json` names this session count.
 */
export interface WorkflowRecovery {
  /**
   * The results a run resuming `runId` replays from its files. It fails when the run is unknown
   * or pruned, left no record, belongs to another session, or still runs in another Pi process.
   */
  readonly replay: (runId: string) => Effect.Effect<WorkflowReplay, WorkflowRequestError>;
  /**
   * The newest runs of this session that a teardown interrupted, or whose Pi process is gone
   * while they ran or before Pi accepted their report, and whose notice Pi never accepted,
   * oldest first. Runs `remembered` reports are left to the memory that holds them.
   */
  readonly interrupted: (
    remembered: (runId: string) => Effect.Effect<boolean>,
  ) => Effect.Effect<ReadonlyArray<WorkflowInterruptedRun>>;
  /** A read-only summary of a run of this session from its files; undefined without one. */
  readonly recorded: (runId: string) => Effect.Effect<WorkflowRecordedRun | undefined>;
  /**
   * Whether the run's record names this session and says Pi accepted a notice or report for it,
   * as another Pi process of the session may have.
   */
  readonly noticeAccepted: (runId: string) => Effect.Effect<boolean>;
}

export interface WorkflowRecoveryServices {
  readonly store: Pick<
    WorkflowStoreContract,
    "readRunRecord" | "hasRunFiles" | "listRunRecords" | "readRunJournal" | "readRunResult"
  >;
  /** The Pi session id run records must name; without one nothing is read. */
  readonly sessionKey: string | undefined;
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

/** What tells whether the process the file's record names still runs. */
const livenessOf = (file: WorkflowRunRecordFile) =>
  Clock.currentTimeMillis.pipe(
    Effect.map(
      (now): WorkflowRunLiveness => ({
        currentPid: currentProcessId(),
        bootedAt: currentBootTime(now),
        now,
        writtenAt: file.writtenAt,
        isAlive: isProcessAlive,
      }),
    ),
  );

/** Characters the journal's lines took to read, newlines included. */
const charsRead = (lines: ReadonlyArray<string>): number =>
  lines.reduce((total, line) => total + line.length + 1, 0);

const unknownRun = (runId: string) =>
  workflowRequestError(
    "resume_unknown",
    `No workflow run ${runId} is known to this Pi session, and no run files were found for it; they may have been pruned. Pi keeps the newest 64 run directories and any written in the last day.`,
  );

const unrecordedRun = (runId: string) =>
  workflowRequestError(
    "resume_unrecorded",
    `Workflow run ${runId} left no run record, so it can't be resumed after a Pi restart: the record couldn't be saved, or its session had no stable id. Start the script without resumeFromRunId instead.`,
  );

const unreadable = (runId: string) => (error: WorkflowRunFileError) =>
  workflowRequestError(
    "resume_unreadable",
    `Workflow run ${runId} can't be resumed: ${error.message}`,
  );

export const makeWorkflowRecovery = (services: WorkflowRecoveryServices): WorkflowRecovery => {
  const { store, sessionKey } = services;

  /** The record when it names this session; undefined when it is missing, unreadable or another's. */
  const ownRecord = (file: WorkflowRunRecordFile | undefined) => {
    const record = file && decodeWorkflowRunRecord(file.text, file.runId);
    return record?.sessionKey === sessionKey ? record : undefined;
  };

  const readLines = (files: WorkflowRunFiles) =>
    store
      .readRunJournal(files, WORKFLOW_JOURNAL_MAX_CHARS)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

  /** A line's full result, read from the file it names within `budget`, and the text read. */
  const fullResult = (files: WorkflowRunFiles, line: WorkflowReplayLine, budget: number) =>
    line.resultFile === undefined
      ? Effect.succeed({ result: Option.some(line.result), read: 0 })
      : store.readRunResult(files, line.resultFile, budget).pipe(
          Effect.map((text) => ({
            result: text === undefined ? Option.none<Schema.Json>() : decodeJson(text),
            read: text?.length ?? 0,
          })),
        );

  /** A line's entry; undefined when its full result is missing, too large or malformed. */
  const entryOf = (files: WorkflowRunFiles, line: WorkflowReplayLine, budget: number) =>
    fullResult(files, line, budget).pipe(
      Effect.map(({ result, read }) => {
        if (Option.isNone(result)) return undefined;
        const entry: WorkflowJournalEntry = {
          key: line.key,
          result: result.value,
          outputTokens: line.outputTokens,
          chars: canonicalResultJson(result.value).length,
          ...(line.workspaceId !== undefined && { workspaceId: line.workspaceId }),
          ...(line.label !== undefined && { label: line.label }),
          ...(line.runId !== undefined && { runId: line.runId }),
        };
        return { entry, read };
      }),
    );

  /** Replay entries from the run's journal and result files, reading at most the journal bound. */
  const replayEntries = (files: WorkflowRunFiles, lines: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      let budget = WORKFLOW_JOURNAL_MAX_CHARS - charsRead(lines);
      const entries: WorkflowJournalEntry[] = [];
      for (const line of readWorkflowResultLines(lines).replayable) {
        const found = yield* entryOf(files, line, Math.max(0, budget));
        if (!found) continue;
        budget -= found.read;
        entries.push(found.entry);
      }
      return entries;
    });

  /** A run without a record: its files are gone, or it couldn't save one. */
  const missingRun = (runId: string) =>
    Effect.gen(function* () {
      return yield* (yield* store.hasRunFiles(runId)) ? unrecordedRun(runId) : unknownRun(runId);
    });

  const replay: WorkflowRecovery["replay"] = (runId) =>
    Effect.gen(function* () {
      if (sessionKey === undefined) return yield* missingRun(runId);
      const file = yield* store.readRunRecord(runId).pipe(Effect.mapError(unreadable(runId)));
      if (!file) return yield* missingRun(runId);
      const record = decodeWorkflowRunRecord(file.text, runId);
      if (!record)
        return yield* workflowRequestError(
          "resume_unreadable",
          `Workflow run ${runId} can't be resumed: its run.json isn't a valid run record.`,
        );
      if (record.sessionKey !== sessionKey)
        return yield* workflowRequestError(
          "resume_other_session",
          `Workflow run ${runId} belongs to another Pi session, so this session can't resume it. Start the script without resumeFromRunId instead.`,
        );
      if (isWorkflowRunLiveElsewhere(record, yield* livenessOf(file)))
        return yield* workflowRequestError(
          "resume_running_elsewhere",
          `Workflow run ${runId} is still running in another Pi process (pid ${record.pid}). Stop it there or wait for its result before resuming it.`,
        );
      const lines = yield* store
        .readRunJournal(file.files, WORKFLOW_JOURNAL_MAX_CHARS)
        .pipe(Effect.mapError(unreadable(runId)));
      return makeWorkflowReplay(yield* replayEntries(file.files, lines));
    });

  /** The notice a run owes, or undefined when it owes none or memory reports it. */
  const owedNotice = (
    file: WorkflowRunRecordFile,
    remembered: (runId: string) => Effect.Effect<boolean>,
  ) =>
    Effect.gen(function* () {
      const record = ownRecord(file);
      if (!record || !isWorkflowRunNoticeOwed(record, yield* livenessOf(file))) return undefined;
      if (yield* remembered(record.runId)) return undefined;
      const reading = readWorkflowResultLines(yield* readLines(file.files));
      const notice: WorkflowInterruptedRun = {
        runId: record.runId,
        name: record.name,
        finished: reading.finished,
        workspaces: reading.workspaces,
        ...(record.stoppedBy !== undefined && { stopped: true }),
        ...(isWorkflowRunFinished(record.state) && { ended: record.state }),
        origin: { source: record.source, scriptPath: record.scriptPath },
        restarted: true,
      };
      return notice;
    });

  const interrupted: WorkflowRecovery["interrupted"] = (remembered) =>
    Effect.gen(function* () {
      if (sessionKey === undefined) return [];
      const files = yield* store.listRunRecords(
        WORKFLOW_RETAINED_RUNS,
        (file) => ownRecord(file) !== undefined,
      );
      const owed = yield* Effect.forEach(files.toReversed(), (file) =>
        owedNotice(file, remembered),
      );
      return owed.filter((notice) => notice !== undefined);
    });

  /** The run's files and record when the record names this session; undefined otherwise. */
  const ownRun = (runId: string) =>
    Effect.gen(function* () {
      if (sessionKey === undefined) return undefined;
      const file = yield* store.readRunRecord(runId).pipe(Effect.orElseSucceed(() => undefined));
      const record = ownRecord(file);
      return file && record ? { file, record } : undefined;
    });

  const recorded: WorkflowRecovery["recorded"] = (runId) =>
    Effect.gen(function* () {
      const own = yield* ownRun(runId);
      if (!own) return undefined;
      const lines = yield* readLines(own.file.files);
      return workflowRecordedRun(
        own.record,
        isWorkflowRunLiveElsewhere(own.record, yield* livenessOf(own.file)),
        readWorkflowResultLines(lines).finished,
        lines.length > 0 ? own.file.files.journal : undefined,
      );
    });

  const noticeAccepted: WorkflowRecovery["noticeAccepted"] = (runId) =>
    ownRun(runId).pipe(Effect.map((own) => own?.record.notified === true));

  return { replay, interrupted, recorded, noticeAccepted };
};
