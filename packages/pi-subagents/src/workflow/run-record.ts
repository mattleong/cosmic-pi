import { absurd } from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { WorkflowRunView, WorkflowSource, WorkflowStopOrigin } from "./model.ts";

export const WORKFLOW_RUN_RECORD_MAX_BYTES = 64 * 1024;

export const WORKFLOW_RUN_FILES_REFRESH_MS = 60 * 1_000;
export const WORKFLOW_RUN_HEARTBEAT_MS = 2 * 60 * 60 * 1_000;
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
  pid: Schema.Int,
  bootedAt: Schema.optional(Time),
  startedAt: Time,
  state: Schema.Literals(["running", "completed", "failed", "stopped", "interrupted"]),
  stoppedBy: Schema.optional(Schema.Literals(["tool", "user"])),
  endedAt: Schema.optional(Time),
  notified: Schema.Boolean,
});

export type WorkflowRunRecord = typeof WorkflowRunRecordSchema.Type;
type WorkflowRunRecordState = WorkflowRunRecord["state"];

const decodeRecord = Schema.decodeUnknownOption(Schema.fromJsonString(WorkflowRunRecordSchema));

export const decodeWorkflowRunRecord = (
  text: string,
  runId: string,
): WorkflowRunRecord | undefined =>
  Option.getOrUndefined(Option.filter(decodeRecord(text), (record) => record.runId === runId));

export const workflowRunRecordText = (record: WorkflowRunRecord): string => JSON.stringify(record);

export const startedWorkflowRunRecord = (
  run: Pick<WorkflowRunView, "id" | "name" | "source" | "scriptPath" | "startedAt">,
  sessionKey: string,
  owner: { readonly pid: number; readonly bootedAt: number },
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

export const notifiedWorkflowRunRecord = (record: WorkflowRunRecord): WorkflowRunRecord => ({
  ...record,
  state: record.state === "running" ? "interrupted" : record.state,
  notified: true,
});

export interface WorkflowRunLiveness {
  readonly currentPid: number;
  readonly bootedAt: number;
  readonly now: number;
  readonly writtenAt: number | undefined;
  readonly isAlive: (pid: number) => boolean;
}

const processMayRun = (record: WorkflowRunRecord, liveness: WorkflowRunLiveness): boolean =>
  (record.bootedAt === undefined ||
    Math.abs(record.bootedAt - liveness.bootedAt) <= BOOT_TIME_TOLERANCE_MS) &&
  liveness.isAlive(record.pid);

export const isWorkflowRunLiveElsewhere = (
  record: WorkflowRunRecord,
  liveness: WorkflowRunLiveness,
): boolean =>
  record.state === "running" &&
  record.pid !== liveness.currentPid &&
  (liveness.writtenAt === undefined ||
    liveness.now - liveness.writtenAt <= WORKFLOW_RUN_HEARTBEAT_MS) &&
  processMayRun(record, liveness);

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
  return absurd(record.state);
};

export interface WorkflowRecordedRun {
  readonly id: string;
  readonly name: string;
  readonly source: WorkflowSource;
  readonly scriptPath?: string | undefined;
  readonly state: WorkflowRunRecordState;
  readonly runningIn?: number | undefined;
  readonly stoppedBy?: WorkflowStopOrigin | undefined;
  readonly startedAt: number;
  readonly endedAt?: number | undefined;
  readonly finished: number;
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
