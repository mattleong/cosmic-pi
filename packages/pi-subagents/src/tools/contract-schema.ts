import { flow } from "effect/Function";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import { decodeUnknownOrUndefined, freezeSnapshot } from "pi-cosmic-core";
import {
  PROFILE_CANDIDATE_RUNTIMES,
  PROFILE_CANDIDATE_WRITE_INTENTS,
  PROFILE_IDS,
} from "../profiles/model.ts";
import {
  MAX_AGENT_TARGETS,
  MAX_MAIN_READ_CHARS,
  MAX_RUN_READ_CHARS,
} from "../run/agent-messaging.ts";
import {
  MAX_CONTACT_TEXT_CHARS,
  MAX_LIFECYCLE_TARGET_RUNS,
  MAX_OUTCOME_FILE_PATH_CHARS,
  MAX_OUTCOME_PREVIEW_CHARS,
  MAX_PROTOCOL_ID_CHARS,
  MAX_START_BATCH,
  MAX_TARGET_RUNS,
} from "../run/limits.ts";
import {
  FAILED_START_CLEANUP_DISPOSITIONS,
  PI_SUBAGENT_CAPABILITIES,
  SUBAGENT_RUN_STATES,
} from "../run/model.ts";
import { MAX_NAME_CHARS } from "../run/state.ts";
import { AGENT_TOOL_NAME, SUBAGENT_TOOL_NAME } from "../run/tool-policy.ts";
import {
  AgentNameSchema,
  MAX_FAILURE_CODE_CHARS,
  ModelOverrideCardSchema,
  NonEmptyText,
  RunCleanupSchema,
} from "./details-schema.ts";
import { ModelsContractFields } from "./discovery-contract-schema.ts";
import type { ActionFailureDisposition } from "./outcome.ts";
import { AWAIT_UNTIL, LIFECYCLE_ACTIONS } from "./schema.ts";

/**
 * A target's report text without a file, error, question, and warnings are previews, so each
 * target stays bounded; agent_read returns the rest, and a read's status carries them whole.
 */
export const MAX_CONTRACT_PREVIEW_CHARS = MAX_OUTCOME_PREVIEW_CHARS;
export const MAX_CONTRACT_MESSAGE_CHARS = 1_024;
export const MAX_CONTRACT_TASK_CHARS = 256;
export const MAX_CONTRACT_MODEL_CHARS = 256;

const FAILURE_DISPOSITIONS = [
  "unconfirmed",
  "failed",
] as const satisfies ReadonlyArray<ActionFailureDisposition>;

const count = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const RunIdSchema = NonEmptyText(MAX_PROTOCOL_ID_CHARS);
const RunIdsSchema = Schema.Array(RunIdSchema).check(Schema.isMaxLength(MAX_TARGET_RUNS));
const NameSchema = NonEmptyText(MAX_NAME_CHARS);
const ProfileSchema = Schema.Literals(PROFILE_IDS);
const StateSchema = Schema.Literals(SUBAGENT_RUN_STATES);
const WriteIntentSchema = Schema.Literals(PROFILE_CANDIDATE_WRITE_INTENTS);
const UntilSchema = Schema.Literals(AWAIT_UNTIL);

const envelope = <Tool extends string>(tool: Tool) => ({ tool: Schema.Literal(tool) });

const WITHHELD_REPORT_STATUSES = [
  // A wait ended (cancelled, timed out, or by user input) before delivering a report it held.
  "deferred",
  "claimed",
  "already_delivered",
  "missing",
  "not_finished",
  "unknown",
] as const;

const WithheldReportSchema = Schema.Struct({ status: Schema.Literals(WITHHELD_REPORT_STATUSES) });
/** The private file holding an assignment's report; `complete` is false past the 1 MiB archive cap. */
const ReportFileFields = {
  path: NonEmptyText(MAX_OUTCOME_FILE_PATH_CHARS),
  chars: count,
  lines: count,
  complete: Schema.Boolean,
};
const ReportSchema = Schema.Union([
  // Delivering a report hands over its file; the parent reads the report from it.
  Schema.Struct({ status: Schema.Literal("delivered"), ...ReportFileFields }),
  // Only a report whose file couldn't be saved arrives inline, as a preview cut when `truncated`;
  // agent_read returns the retained report.
  Schema.Struct({
    status: Schema.Literal("delivered"),
    text: NonEmptyText(MAX_CONTRACT_PREVIEW_CHARS),
    truncated: Schema.Boolean,
  }),
  WithheldReportSchema,
]);

const attentionSchema = (questionChars: number) =>
  Schema.Union([
    Schema.Struct({ kind: Schema.Literal("question-unavailable") }),
    Schema.Struct({ kind: Schema.Literal("paused"), canResume: Schema.Boolean }),
    Schema.Struct({ kind: Schema.Literal("question"), message: NonEmptyText(questionChars) }),
  ]);
/** A question's preview; its notice delivers the whole question. */
const AttentionSchema = attentionSchema(MAX_CONTRACT_PREVIEW_CHARS);

const FailureSchema = Schema.Struct({
  disposition: Schema.Literals(FAILURE_DISPOSITIONS),
  code: Schema.optionalKey(NonEmptyText(MAX_FAILURE_CODE_CHARS)),
  message: NonEmptyText(MAX_CONTRACT_MESSAGE_CHARS),
});

/** `detailChars` bounds the question, warnings, and error: previews, or a read's whole text. */
const runTargetFields = <Report extends Schema.Top>(report: Report, detailChars: number) => ({
  runId: RunIdSchema,
  name: NameSchema,
  profile: Schema.optionalKey(ProfileSchema),
  agent: Schema.optionalKey(AgentNameSchema),
  state: StateSchema,
  finished: Schema.Boolean,
  writeIntent: WriteIntentSchema,
  modelOverride: Schema.optionalKey(ModelOverrideCardSchema),
  parentActionRequired: Schema.Boolean,
  writerCleanupQuarantined: Schema.optionalKey(Schema.Boolean),
  attention: Schema.optionalKey(attentionSchema(detailChars)),
  warnings: Schema.Array(
    Schema.Struct({
      source: Schema.optionalKey(Schema.Literals(["child", "system"])),
      message: NonEmptyText(detailChars),
    }),
  ).check(Schema.isMaxLength(2)),
  error: Schema.optionalKey(NonEmptyText(detailChars)),
  /** The saved failure when `error` is a cut preview. */
  errorFile: Schema.optionalKey(Schema.Struct(ReportFileFields)),
  report,
});

const RunTargetSchema = Schema.Struct(runTargetFields(ReportSchema, MAX_CONTRACT_PREVIEW_CHARS));
const WithheldRunTargetSchema = Schema.Struct(
  runTargetFields(WithheldReportSchema, MAX_CONTRACT_PREVIEW_CHARS),
);
/**
 * A read's status, the detail surface, carries the whole pending question, both retained warnings,
 * and the error, plus the run's capabilities and cleanup evidence.
 */
const ReadStatusSchema = Schema.Struct({
  ...runTargetFields(WithheldReportSchema, MAX_CONTACT_TEXT_CHARS),
  capabilities: Schema.Array(Schema.Literals(PI_SUBAGENT_CAPABILITIES)).check(
    Schema.isMaxLength(PI_SUBAGENT_CAPABILITIES.length),
  ),
  cleanup: Schema.optionalKey(RunCleanupSchema),
});
const RunTargetsSchema = Schema.Array(RunTargetSchema).check(Schema.isMaxLength(MAX_TARGET_RUNS));

const StartContractSchema = Schema.Struct({
  ...envelope(SUBAGENT_TOOL_NAME.start),
  outcome: Schema.Literals(["started", "partial", "failed"]),
  launches: Schema.Array(
    Schema.Union([
      Schema.Struct({
        index: count,
        status: Schema.Literal("started"),
        runId: RunIdSchema,
        name: NameSchema,
        profile: Schema.optionalKey(ProfileSchema),
        agent: Schema.optionalKey(AgentNameSchema),
        state: StateSchema,
        writeIntent: WriteIntentSchema,
        modelOverride: Schema.optionalKey(ModelOverrideCardSchema),
      }),
      Schema.Struct({
        index: count,
        status: Schema.Literal("failed"),
        name: Schema.optionalKey(NameSchema),
        profile: Schema.optionalKey(ProfileSchema),
        agent: Schema.optionalKey(AgentNameSchema),
        failure: FailureSchema,
        admittedRun: Schema.optionalKey(
          Schema.Struct({
            runId: RunIdSchema,
            cleanup: Schema.Literals(FAILED_START_CLEANUP_DISPOSITIONS),
          }),
        ),
      }),
    ]),
  ).check(Schema.isMaxLength(MAX_START_BATCH)),
});

// One struct rather than a union per outcome: Pi's codemode description summarizes an object's
// fields but renders any other output schema in full on every request.
const AwaitContractSchema = Schema.Struct({
  ...envelope(SUBAGENT_TOOL_NAME.await),
  outcome: Schema.Literals(["finished", "attention", "cancelled", "timed_out", "user_input"]),
  until: UntilSchema,
  requestedRunIds: RunIdsSchema,
  /** An ended wait (cancelled, timed out, or user input) withholds every report. */
  targets: RunTargetsSchema,
  /** Only on an ended wait. */
  unobservedRunIds: Schema.optionalKey(RunIdsSchema),
  /** Only on an ended wait. */
  cleanup: Schema.optionalKey(Schema.Literals(["confirmed", "unconfirmed"])),
});

const LifecycleContractSchema = Schema.Struct({
  ...envelope(SUBAGENT_TOOL_NAME.lifecycle),
  action: Schema.Literals(LIFECYCLE_ACTIONS),
  outcome: Schema.Literals(["succeeded", "partial", "failed"]),
  results: Schema.Array(
    Schema.Union([
      Schema.Struct({
        requestedRunId: RunIdSchema,
        status: Schema.Literal("succeeded"),
        target: RunTargetSchema,
      }),
      Schema.Struct({
        requestedRunId: RunIdSchema,
        status: Schema.Literal("failed"),
        failure: FailureSchema,
      }),
    ]),
  ).check(Schema.isMaxLength(MAX_LIFECYCLE_TARGET_RUNS)),
});

const ModelsContractSchema = Schema.Struct({
  ...envelope(SUBAGENT_TOOL_NAME.models),
  ...ModelsContractFields,
});

const AgentIdsSchema = Schema.Array(RunIdSchema).check(Schema.isMaxLength(MAX_AGENT_TARGETS));
const MainStateSchema = Schema.Literals(["idle", "busy"]);
const AgentTextFields = {
  textStatus: Schema.Literals(["text", "none"]),
  truncated: Schema.Boolean,
};

// `main` and every run in the root tree, parents before children.
const AgentListContractSchema = Schema.Struct({
  ...envelope(AGENT_TOOL_NAME.list),
  agents: Schema.Array(
    Schema.Struct({
      id: RunIdSchema,
      name: NameSchema,
      kind: Schema.Literals(["main", "run"]),
      state: Schema.Union([StateSchema, MainStateSchema, Schema.Literal("unavailable")]),
      parentId: Schema.optionalKey(RunIdSchema),
      depth: Schema.optionalKey(count),
      runtime: Schema.optionalKey(Schema.Literals(PROFILE_CANDIDATE_RUNTIMES)),
      /** The run's runtime, model, and effort, such as `pi/provider/model:high`. */
      model: Schema.optionalKey(NonEmptyText(MAX_CONTRACT_MODEL_CHARS)),
      profile: Schema.optionalKey(ProfileSchema),
      agent: Schema.optionalKey(AgentNameSchema),
      writeIntent: Schema.optionalKey(WriteIntentSchema),
      /** A worktree writer's private tree; its proposal is applied with `agent_worktree`. */
      worktree: Schema.optionalKey(
        Schema.Struct({
          workspaceId: RunIdSchema,
          status: Schema.Literals(["open", "proposal", "applied", "discarded"]),
          changedFileCount: Schema.optionalKey(count),
        }),
      ),
      attention: Schema.optionalKey(AttentionSchema),
      task: Schema.optionalKey(NonEmptyText(MAX_CONTRACT_TASK_CHARS)),
      self: Schema.Boolean,
    }),
  ),
  missingIds: AgentIdsSchema,
});

const AgentReadContractSchema = Schema.Struct({
  ...envelope(AGENT_TOOL_NAME.read),
  agents: Schema.Array(
    Schema.Union([
      Schema.Struct({
        kind: Schema.Literal("main"),
        id: RunIdSchema,
        name: NameSchema,
        state: Schema.Union([MainStateSchema, Schema.Literal("unavailable")]),
        ...AgentTextFields,
        text: Schema.optionalKey(NonEmptyText(MAX_MAIN_READ_CHARS)),
      }),
      Schema.Struct({
        kind: Schema.Literal("run"),
        id: RunIdSchema,
        name: NameSchema,
        state: StateSchema,
        ...AgentTextFields,
        text: Schema.optionalKey(NonEmptyText(MAX_RUN_READ_CHARS)),
        source: Schema.optionalKey(Schema.Literals(["assistant", "report", "error"])),
        /** A finished run's saved report; `text` is the copy it retained, cut when `truncated`. */
        reportFile: Schema.optionalKey(Schema.Struct(ReportFileFields)),
        reportGeneration: count,
        /** The run's status card; its report is the read's `reportFile` or `text`. */
        status: ReadStatusSchema,
      }),
    ]),
  ).check(Schema.isMaxLength(MAX_AGENT_TARGETS)),
  missingIds: AgentIdsSchema,
});

export const CONTRACT_SCHEMAS = {
  [SUBAGENT_TOOL_NAME.start]: StartContractSchema,
  [SUBAGENT_TOOL_NAME.await]: AwaitContractSchema,
  [SUBAGENT_TOOL_NAME.lifecycle]: LifecycleContractSchema,
  [SUBAGENT_TOOL_NAME.models]: ModelsContractSchema,
  [AGENT_TOOL_NAME.list]: AgentListContractSchema,
  [AGENT_TOOL_NAME.read]: AgentReadContractSchema,
} as const;

export type SubagentContractTool = keyof typeof CONTRACT_SCHEMAS;
export type SubagentContract<Tool extends SubagentContractTool = SubagentContractTool> =
  (typeof CONTRACT_SCHEMAS)[Tool]["Type"];
export type SubagentStartContract = SubagentContract<typeof SUBAGENT_TOOL_NAME.start>;
export type SubagentAwaitContract = SubagentContract<typeof SUBAGENT_TOOL_NAME.await>;
export type SubagentLifecycleContract = SubagentContract<typeof SUBAGENT_TOOL_NAME.lifecycle>;
export type SubagentModelsContract = SubagentContract<typeof SUBAGENT_TOOL_NAME.models>;
export type AgentListContract = SubagentContract<typeof AGENT_TOOL_NAME.list>;
export type AgentReadContract = SubagentContract<typeof AGENT_TOOL_NAME.read>;
export type ContractRunTarget = typeof RunTargetSchema.Type;
export type ContractWithheldRunTarget = typeof WithheldRunTargetSchema.Type;
export type ContractReadStatus = typeof ReadStatusSchema.Type;
export type ContractReport = typeof ReportSchema.Type;
export type ContractWithheldReport = typeof WithheldReportSchema.Type;
export type ContractAttention = typeof AttentionSchema.Type;
export type ContractFailure = typeof FailureSchema.Type;
export type ContractStartLaunch = SubagentStartContract["launches"][number];
export type ContractLifecycleResult = SubagentLifecycleContract["results"][number];
export type ContractLifecycleAction = SubagentLifecycleContract["action"];

const STRICT_PARSE_OPTIONS = { errors: "first", onExcessProperty: "error" } as const;

export const SubagentContractSchema = Schema.Union([
  StartContractSchema,
  AwaitContractSchema,
  LifecycleContractSchema,
  ModelsContractSchema,
  AgentListContractSchema,
  AgentReadContractSchema,
]);
export const encodeSubagentContract = Schema.encodeSync(
  Schema.toCodecJson(SubagentContractSchema),
  STRICT_PARSE_OPTIONS,
);

export const isSubagentContractTool = Schema.is(Schema.Literals(Rec.keys(CONTRACT_SCHEMAS)));

export const decodeSubagentContract = <Tool extends SubagentContractTool>(tool: Tool) => {
  const schema: (typeof CONTRACT_SCHEMAS)[Tool] = CONTRACT_SCHEMAS[tool];
  return flow(
    decodeUnknownOrUndefined(schema, STRICT_PARSE_OPTIONS),
    (decoded): SubagentContract<Tool> | undefined =>
      decoded === undefined ? undefined : freezeSnapshot(decoded),
  );
};
