/** Success-only native workflow contracts, independent of persisted presentation details. */
import * as Schema from "effect/Schema";
import { decodeUnknownOrUndefined, freezeSnapshot } from "pi-cosmic-core";
import { WORKFLOW_TOOL_NAME } from "./workflow-schema.ts";

export const WORKFLOW_CONTRACT_ID = "pi-subagents/workflow";
const count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const time = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const text = Schema.String;
const state = Schema.Literals(["running", "stopping", "completed", "failed", "stopped"]);
const agentState = Schema.Literals([
  "queued",
  "running",
  "completed",
  "failed",
  "stopped",
  "skipped",
]);
const source = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("inline") }),
  Schema.Struct({ kind: Schema.Literal("file"), path: text }),
  Schema.Struct({
    kind: Schema.Literal("saved"),
    name: text,
    scope: Schema.Literals(["project", "user"]),
    path: text,
  }),
]);
const phase = Schema.Struct({
  title: text,
  detail: Schema.optionalKey(text),
  agents: Schema.optionalKey(
    Schema.Array(
      Schema.Union([text, Schema.Struct({ label: text, profile: Schema.optionalKey(text) })]),
    ),
  ),
});
const log = Schema.Struct({ at: time, level: Schema.Literals(["info", "warning"]), message: text });
const budget = Schema.Struct({ total: count, spent: count, refused: count });
const usage = Schema.Struct({
  input: count,
  output: count,
  cacheRead: count,
  cacheWrite: count,
  totalTokens: count,
  cost: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  toolUses: count,
  unpriced: count,
});
const waiting = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("slot") }),
  Schema.Struct({
    kind: Schema.Literal("writer"),
    runId: text,
    name: text,
    paused: Schema.Boolean,
  }),
]);
const agent = Schema.Struct({
  callId: count,
  runId: text,
  label: text,
  phase: Schema.optionalKey(text),
  profile: Schema.optionalKey(text),
  state: agentState,
  queuedAt: time,
  startedAt: Schema.optionalKey(time),
  endedAt: Schema.optionalKey(time),
  workspaceId: Schema.optionalKey(text),
  unchanged: Schema.optionalKey(Schema.Literal(true)),
  reason: Schema.optionalKey(text),
  waiting: Schema.optionalKey(waiting),
});
const planned = Schema.Struct({
  runId: text,
  phase: text,
  label: text,
  profile: Schema.optionalKey(text),
  workflow: Schema.optionalKey(text),
  skippedAt: Schema.optionalKey(time),
});
const attentionFields = { runId: text, writer: Schema.Boolean };
const attention = Schema.Union([
  Schema.Struct({
    ...attentionFields,
    kind: Schema.Literals(["containment", "admission-paused", "question-unavailable"]),
  }),
  Schema.Struct({ ...attentionFields, kind: Schema.Literal("paused"), canResume: Schema.Boolean }),
  Schema.Struct({ ...attentionFields, kind: Schema.Literal("question"), message: text }),
]);
const reference = {
  id: text,
  name: text,
  state,
  startedAt: time,
  source,
  scriptPath: Schema.optionalKey(text),
  resumedFrom: Schema.optionalKey(text),
};
const receipt = Schema.Struct({
  ...reference,
  budget: Schema.optionalKey(budget),
  warnings: Schema.optionalKey(Schema.Array(log)),
});
const liveRun = Schema.Struct({
  ...receipt.fields,
  description: text,
  endedAt: Schema.optionalKey(time),
  phases: Schema.Array(phase),
  currentPhase: Schema.optionalKey(text),
  agents: Schema.Array(agent),
  planned: Schema.Array(planned),
  reused: count,
  reusedPhases: Schema.optionalKey(Schema.Array(Schema.Struct({ title: text, count }))),
  reusedWorkspaces: Schema.optionalKey(
    Schema.Array(Schema.Struct({ workspaceId: text, label: text })),
  ),
  /** Actionable proposals only, as workflowWorkspaces computes them. */
  workspaces: Schema.Array(
    Schema.Struct({
      workspaceId: text,
      label: text,
      state: Schema.Union([agentState, Schema.Literal("reused")]),
    }),
  ),
  stoppedBy: Schema.optionalKey(Schema.Literals(["tool", "user"])),
  logs: Schema.Array(log),
  lastLog: Schema.optionalKey(text),
  warningCount: Schema.optionalKey(count),
  usage,
  journalPath: Schema.optionalKey(text),
  /** Bounded domain text, not a parsed or necessarily complete JSON value. */
  result: Schema.optionalKey(
    Schema.Struct({ text, clipped: Schema.Boolean, path: Schema.optionalKey(text) }),
  ),
  failure: Schema.optionalKey(
    Schema.Struct({
      kind: Schema.optionalKey(Schema.Literals(["script", "timeout", "sandbox", "runner"])),
      name: Schema.optionalKey(text),
      message: text,
      stack: Schema.optionalKey(text),
    }),
  ),
});
const recordedRun = Schema.Struct({
  id: text,
  name: text,
  source,
  scriptPath: Schema.optionalKey(text),
  state: Schema.Literals(["running", "completed", "failed", "stopped", "interrupted"]),
  /** Another Pi process, not this activation's owner. */
  runningIn: Schema.optionalKey(count),
  stoppedBy: Schema.optionalKey(Schema.Literals(["tool", "user"])),
  startedAt: time,
  endedAt: Schema.optionalKey(time),
  /** Finished agent results available for reuse; never a terminal boolean. */
  finished: count,
  journalPath: Schema.optionalKey(text),
});
const counts = Schema.Struct({
  queued: count,
  running: count,
  completed: count,
  failed: count,
  stopped: count,
  skipped: count,
});
const envelope = {
  contract: Schema.Literal(WORKFLOW_CONTRACT_ID),
  version: Schema.Literal(1),
  tool: Schema.Literal(WORKFLOW_TOOL_NAME),
};
const start = Schema.Struct({ ...envelope, action: Schema.Literal("start"), run: receipt });
const statusFields = { ...envelope, action: Schema.Literal("status") };
const status = Schema.Union([
  Schema.Struct({
    ...statusFields,
    kind: Schema.Literal("view"),
    run: liveRun,
    attention: Schema.Array(attention),
  }),
  Schema.Struct({
    ...statusFields,
    kind: Schema.Literal("unchanged"),
    run: liveRun,
    sinceMs: time,
    attention: Schema.Array(attention).check(Schema.isMaxLength(0)),
  }),
  Schema.Struct({ ...statusFields, kind: Schema.Literal("recorded"), run: recordedRun }),
]);
const stop = Schema.Struct({ ...envelope, action: Schema.Literal("stop"), run: liveRun });
const list = Schema.Struct({
  ...envelope,
  action: Schema.Literal("list"),
  saved: Schema.Struct({
    workflows: Schema.Array(
      Schema.Struct({
        name: text,
        scope: Schema.Literals(["project", "user"]),
        path: text,
        meta: Schema.Struct({
          name: text,
          description: text,
          whenToUse: Schema.optionalKey(text),
          phases: Schema.optionalKey(Schema.Array(phase)),
          args: Schema.optionalKey(Schema.Json),
        }),
      }),
    ),
    diagnostics: Schema.Array(Schema.Struct({ path: text, message: text })),
    /** Only saved-name enumeration is truncated; this does not describe diagnostics. */
    truncated: Schema.Boolean,
    locations: Schema.Struct({ project: text, projectTrusted: Schema.Boolean, user: text }),
  }),
  runs: Schema.Array(
    Schema.Struct({
      ...reference,
      endedAt: Schema.optionalKey(time),
      journalPath: Schema.optionalKey(text),
      stoppedBy: Schema.optionalKey(Schema.Literals(["tool", "user"])),
      counts,
      planned: count,
      reused: count,
      total: count,
    }),
  ),
});
export const WorkflowContractSchema = Schema.Union([start, status, stop, list]);
export type WorkflowContract = typeof WorkflowContractSchema.Type;
export type WorkflowStartContract = typeof start.Type;
export type WorkflowStatusContract = typeof status.Type;
export type WorkflowStopContract = typeof stop.Type;
export type WorkflowListContract = typeof list.Type;
export type WorkflowLiveContract = typeof liveRun.Type;

const strict = { errors: "first", onExcessProperty: "error" } as const;
const encode = Schema.encodeSync(Schema.toCodecJson(WorkflowContractSchema), strict);
/** Validate first, then detach/freeze every nested field, including saved meta.args. */
export const encodeWorkflowContract = (value: WorkflowContract): Schema.Json =>
  freezeSnapshot(encode(value));
export const decodeWorkflowContract = <Input>(value: Input): WorkflowContract | undefined => {
  const decoded = decodeUnknownOrUndefined(WorkflowContractSchema, value, strict);
  return decoded === undefined ? undefined : freezeSnapshot(decoded);
};
