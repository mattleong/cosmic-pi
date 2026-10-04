import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { WorkflowRunView, WorkflowSource, WorkflowStopOrigin } from "./model.ts";

// A run's `run.json`: which session and Pi process run it, and how it ended. A later Pi process of
// the same session reads it to resume the run, to announce one its process left unfinished, and
// to describe it in status. Every reader treats the file as untrusted.

/** What a reader accepts: a record holds paths and a few short fields. */
export const WORKFLOW_RUN_RECORD_MAX_BYTES = 64 * 1024;

/**
 * How often a live run marks its directory recent, well inside the run-directory pruning grace,
 * so a live run's files never age out. The refresh doubles as the run's heartbeat. It is short
 * because timers don't advance while the machine sleeps: a live run marks its directory again
 * within a minute of waking.
 */
export const WORKFLOW_RUN_FILES_REFRESH_MS = 60 * 1_000;
/**
 * A `running` record whose directory went unwritten this long has lost its process, even when
 * its pid now names another process. Far longer than the refresh, so a busy process, or one
 * that has just woken, isn't taken for one that is gone.
 */
export const WORKFLOW_RUN_HEARTBEAT_MS = 2 * 60 * 60 * 1_000;
/**
 * How far a record's boot time may lie from this one's and still name the same boot: a wall-clock
 * adjustment shifts the computed boot time a little, a reboot far more.
 */
const BOOT_TIME_TOLERANCE_MS = 60_000;

const SourceSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("inline") }),
  Schema.Struct({
    kind: Schema.Literal("saved"),
    name: Schema.String,
    scope: Schema.Literals(["project", "user"]),
    path: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("file"), path: Schema.String }),
]);

const Time = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

const WorkflowRunRecordSchema = Schema.Struct({
  version: Schema.Literal(1),
  runId: Schema.String,
  sessionKey: Schema.String,
  name: Schema.String,
  source: SourceSchema,
  scriptPath: Schema.optional(Schema.String),
  /** The Pi process that runs it. */
  pid: Schema.Int,
  /**
   * When the machine running that process booted, in epoch milliseconds, so a later boot doesn't
   * take whatever process now holds the pid for it.
   */
  bootedAt: Schema.optional(Time),
  startedAt: Time,
  /** `running` until it ends; `interrupted` when a teardown ended it before it finished. */
  state: Schema.Literals(["running", "completed", "failed", "stopped", "interrupted"]),
  stoppedBy: Schema.optional(Schema.Literals(["tool", "user"])),
  endedAt: Schema.optional(Time),
  /** Pi accepted its completion notification or interrupted notice, or it needed neither. */
  notified: Schema.Boolean,
});

export type WorkflowRunRecord = typeof WorkflowRunRecordSchema.Type;
export type WorkflowRunRecordState = WorkflowRunRecord["state"];

const decodeRecord = Schema.decodeUnknownOption(Schema.fromJsonString(WorkflowRunRecordSchema));

/** The record in `text`, or undefined when it is malformed or names another run than `runId`. */
export const decodeWorkflowRunRecord = (
  text: string,
  runId: string,
): WorkflowRunRecord | undefined =>
  Option.getOrUndefined(Option.filter(decodeRecord(text), (record) => record.runId === runId));

export const workflowRunRecordText = (record: WorkflowRunRecord): string => JSON.stringify(record);

/** The Pi process that runs a starting run, and when its machine booted. */
export interface WorkflowRunProcess {
  readonly pid: number;
  readonly bootedAt: number;
}

/**
 * A starting run's record, owned by `owner` in session `sessionKey`. The run's args aren't kept:
 * a resume after a restart passes them again, from the session's transcript.
 */
export const startedWorkflowRunRecord = (
  run: Pick<WorkflowRunView, "id" | "name" | "source" | "scriptPath" | "startedAt">,
  sessionKey: string,
  owner: WorkflowRunProcess,
): WorkflowRunRecord => ({
  version: 1,
  runId: run.id,
  sessionKey,
  name: run.name,
  source: run.source,
  ...(run.scriptPath !== undefined && { scriptPath: run.scriptPath }),
  pid: owner.pid,
  bootedAt: owner.bootedAt,
  startedAt: run.startedAt,
  state: "running",
  notified: false,
});

/**
 * The record of a run whose fiber ended: its final state, or `interrupted` when a teardown
 * interrupted it before it finished.
 */
export const endedWorkflowRunRecord = (
  record: WorkflowRunRecord,
  run: WorkflowRunView,
  tornDown: boolean,
): WorkflowRunRecord => {
  const state: WorkflowRunRecordState =
    run.state === "completed" || run.state === "failed"
      ? run.state
      : tornDown
        ? "interrupted"
        : "stopped";
  return {
    ...record,
    state,
    ...(run.stoppedBy !== undefined && { stoppedBy: run.stoppedBy }),
    ...(run.endedAt !== undefined && { endedAt: run.endedAt }),
  };
};

/** Notes who asked the run to stop, so a notice after a crash doesn't offer a restart. */
export const stoppingWorkflowRunRecord = (
  record: WorkflowRunRecord,
  origin: WorkflowStopOrigin,
): WorkflowRunRecord => ({ ...record, stoppedBy: origin });

/**
 * Marks the run's notification or notice as accepted. A record still `running` belongs to a Pi
 * process or activation that is gone, so it now reads as interrupted.
 */
export const notifiedWorkflowRunRecord = (record: WorkflowRunRecord): WorkflowRunRecord => ({
  ...record,
  state: record.state === "running" ? "interrupted" : record.state,
  notified: true,
});

/** What tells whether the Pi process a record names still runs. */
export interface WorkflowRunLiveness {
  readonly currentPid: number;
  /** When this machine booted, in epoch milliseconds. */
  readonly bootedAt: number;
  readonly now: number;
  /** When the run's directory was last written, its heartbeat; undefined when unknown. */
  readonly writtenAt: number | undefined;
  readonly isAlive: (pid: number) => boolean;
}

/**
 * Whether the process the record names may still run: one from an earlier boot is gone, whatever
 * process holds its pid now. A record without a boot time is judged by its pid alone.
 */
const processMayRun = (record: WorkflowRunRecord, liveness: WorkflowRunLiveness): boolean =>
  (record.bootedAt === undefined ||
    Math.abs(record.bootedAt - liveness.bootedAt) <= BOOT_TIME_TOLERANCE_MS) &&
  liveness.isAlive(record.pid);

/**
 * Whether another Pi process still runs it: only that process can stop, report or resume it.
 * A record naming this process belongs to an earlier activation, which is gone, and a live run
 * refreshes its directory, so one whose heartbeat stopped is gone even if its pid was reused.
 */
export const isWorkflowRunLiveElsewhere = (
  record: WorkflowRunRecord,
  liveness: WorkflowRunLiveness,
): boolean =>
  record.state === "running" &&
  record.pid !== liveness.currentPid &&
  (liveness.writtenAt === undefined ||
    liveness.now - liveness.writtenAt <= WORKFLOW_RUN_HEARTBEAT_MS) &&
  processMayRun(record, liveness);

/**
 * Whether this session still owes the main agent a notice about the run, which no notice or
 * report was accepted for: a teardown interrupted it, its Pi process is gone while it ran, or it
 * ended but its process is gone without Pi accepting its report. A live process that ended the
 * run still delivers the report, or announces it after a reload.
 */
export const isWorkflowRunNoticeOwed = (
  record: WorkflowRunRecord,
  liveness: WorkflowRunLiveness,
): boolean => {
  if (record.notified) return false;
  switch (record.state) {
    case "interrupted":
      return true;
    case "running":
      return !isWorkflowRunLiveElsewhere(record, liveness);
    case "completed":
    case "failed":
    case "stopped":
      return record.pid === liveness.currentPid || !processMayRun(record, liveness);
  }
};

/** A run of this session that only its files describe, as status shows it. */
export interface WorkflowRecordedRun {
  readonly id: string;
  readonly name: string;
  readonly source: WorkflowSource;
  readonly scriptPath?: string | undefined;
  /** A run whose Pi process is gone without a final state reads as interrupted. */
  readonly state: WorkflowRunRecordState;
  /** The other Pi process that still runs it. */
  readonly runningIn?: number | undefined;
  readonly stoppedBy?: WorkflowStopOrigin | undefined;
  readonly startedAt: number;
  readonly endedAt?: number | undefined;
  /** Agents that finished with a result, which a resume reuses. */
  readonly finished: number;
  /** Its results journal, once it has a line. */
  readonly journalPath?: string | undefined;
}

export const workflowRecordedRun = (
  record: WorkflowRunRecord,
  liveElsewhere: boolean,
  finished: number,
  journalPath: string | undefined,
): WorkflowRecordedRun => ({
  id: record.runId,
  name: record.name,
  source: record.source,
  ...(record.scriptPath !== undefined && { scriptPath: record.scriptPath }),
  state: record.state === "running" && !liveElsewhere ? "interrupted" : record.state,
  ...(liveElsewhere && { runningIn: record.pid }),
  ...(record.stoppedBy !== undefined && { stoppedBy: record.stoppedBy }),
  startedAt: record.startedAt,
  ...(record.endedAt !== undefined && { endedAt: record.endedAt }),
  finished,
  ...(journalPath !== undefined && { journalPath }),
});
