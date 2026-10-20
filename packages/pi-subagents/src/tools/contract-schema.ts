import { flow } from "effect/Function";
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
import { MAX_PROTOCOL_ID_CHARS, MAX_START_BATCH, MAX_TARGET_RUNS } from "../run/limits.ts";
import {
  FAILED_START_CLEANUP_DISPOSITIONS,
  FAILED_START_RETRY_DISPOSITIONS,
  PI_SUBAGENT_CAPABILITIES,
  SUBAGENT_RUN_STATES,
} from "../run/model.ts";
import { MAX_FINAL_TEXT_CHARS, MAX_NAME_CHARS } from "../run/state.ts";
import { AGENT_TOOL_NAME, SUBAGENT_TOOL_NAME } from "../run/tool-policy.ts";
import {
  AgentNameSchema,
  MAX_CARD_PATH_CHARS,
  MAX_CARD_QUESTION_CHARS,
  MAX_FAILURE_CODE_CHARS,
  ModelOverrideCardSchema,
  NonEmptyText,
  RunCleanupSchema,
} from "./details-schema.ts";
import { ModelsContractFields } from "./discovery-contract-schema.ts";
import type { ActionFailureDisposition } from "./outcome.ts";
import { AWAIT_UNTIL, LIFECYCLE_ACTIONS } from "./schema.ts";

export const SUBAGENT_CONTRACT_ID = "pi-subagents/orchestration";
export const SUBAGENT_CONTRACT_VERSION = 3;
export const MAX_CONTRACT_REPORT_CHARS = MAX_FINAL_TEXT_CHARS;
export const MAX_CONTRACT_MESSAGE_CHARS = 1_024;
export const MAX_CONTRACT_ERROR_CHARS = 2_048;
export const MAX_CONTRACT_QUESTION_CHARS = MAX_CARD_QUESTION_CHARS;
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

const envelope = <Tool extends string>(tool: Tool) => ({
  contract: Schema.Literal(SUBAGENT_CONTRACT_ID),
  version: Schema.Literal(SUBAGENT_CONTRACT_VERSION),
  tool: Schema.Literal(tool),
});

const WITHHELD_REPORT_STATUSES = [
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
  path: NonEmptyText(MAX_CARD_PATH_CHARS),
  chars: count,
  lines: count,
  complete: Schema.Boolean,
};
const ReportSchema = Schema.Union([
  // Delivering a report hands over its file; the parent reads the report from it.
  Schema.Struct({ status: Schema.Literal("delivered"), ...ReportFileFields }),
  // Only a report whose file couldn't be saved arrives inline, cut when `truncated`.
  Schema.Struct({
    status: Schema.Literal("delivered"),
    text: NonEmptyText(MAX_CONTRACT_REPORT_CHARS),
    truncated: Schema.Boolean,
  }),
  WithheldReportSchema,
]);

const AttentionSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("question-unavailable") }),
  Schema.Struct({ kind: Schema.Literal("paused"), canResume: Schema.Boolean }),
  Schema.Struct({
    kind: Schema.Literal("question"),
    message: NonEmptyText(MAX_CONTRACT_QUESTION_CHARS),
  }),
]);

const RecoveryFields = {
  cleanup: Schema.Literals(FAILED_START_CLEANUP_DISPOSITIONS),
  disposition: Schema.Literals(FAILED_START_RETRY_DISPOSITIONS),
  remainingCandidateCount: count,
};

const FailureSchema = Schema.Struct({
  disposition: Schema.Literals(FAILURE_DISPOSITIONS),
  code: Schema.optionalKey(NonEmptyText(MAX_FAILURE_CODE_CHARS)),
  message: NonEmptyText(MAX_CONTRACT_MESSAGE_CHARS),
});

const runTargetSchema = <Report extends Schema.Top>(report: Report) =>
  Schema.Struct({
    runId: RunIdSchema,
    name: NameSchema,
    profile: Schema.optionalKey(ProfileSchema),
    agent: Schema.optionalKey(AgentNameSchema),
    state: StateSchema,
    finished: Schema.Boolean,
    reportGeneration: count,
    writeIntent: WriteIntentSchema,
    modelOverride: Schema.optionalKey(ModelOverrideCardSchema),
    capabilities: Schema.Array(Schema.Literals(PI_SUBAGENT_CAPABILITIES)).check(
      Schema.isMaxLength(PI_SUBAGENT_CAPABILITIES.length),
    ),
    predecessorRunId: Schema.optionalKey(RunIdSchema),
    successorRunId: Schema.optionalKey(RunIdSchema),
    resumedBy: Schema.optionalKey(NonEmptyText(MAX_CONTRACT_MESSAGE_CHARS)),
    parentActionRequired: Schema.Boolean,
    cleanup: Schema.optionalKey(RunCleanupSchema),
    writerCleanupQuarantined: Schema.optionalKey(Schema.Boolean),
    attention: Schema.optionalKey(AttentionSchema),
    retry: Schema.optionalKey(Schema.Struct(RecoveryFields)),
    warnings: Schema.Array(
      Schema.Struct({
        source: Schema.optionalKey(Schema.Literals(["child", "system"])),
        message: NonEmptyText(MAX_CONTRACT_MESSAGE_CHARS),
      }),
    ).check(Schema.isMaxLength(2)),
    error: Schema.optionalKey(NonEmptyText(MAX_CONTRACT_ERROR_CHARS)),
    report,
  });

const RunTargetSchema = runTargetSchema(ReportSchema);
const WithheldRunTargetSchema = runTargetSchema(WithheldReportSchema);
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
        admittedRun: Schema.optionalKey(Schema.Struct({ runId: RunIdSchema, ...RecoveryFields })),
      }),
    ]),
  ).check(Schema.isMaxLength(MAX_START_BATCH)),
});

const awaitFields = {
  ...envelope(SUBAGENT_TOOL_NAME.await),
  until: UntilSchema,
  requestedRunIds: RunIdsSchema,
};
const AwaitContractSchema = Schema.Union([
  Schema.Struct({
    ...awaitFields,
    outcome: Schema.Literals(["finished", "attention"]),
    targets: RunTargetsSchema,
  }),
  Schema.Struct({
    ...awaitFields,
    outcome: Schema.Literals(["cancelled", "timed_out", "user_input"]),
    targets: Schema.Array(WithheldRunTargetSchema).check(Schema.isMaxLength(MAX_TARGET_RUNS)),
    unobservedRunIds: RunIdsSchema,
    cleanup: Schema.Literals(["confirmed", "unconfirmed"]),
  }),
]);

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
  ).check(Schema.isMaxLength(MAX_TARGET_RUNS)),
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
        /** A finished run's saved report, given instead of its text; read the file for the report. */
        reportFile: Schema.optionalKey(Schema.Struct(ReportFileFields)),
        reportGeneration: count,
        /** The run's status card; its report is the read's `reportFile` or `text`. */
        status: WithheldRunTargetSchema,
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
export type ContractReport = typeof ReportSchema.Type;
export type ContractWithheldReport = typeof WithheldReportSchema.Type;
export type ContractAttention = typeof AttentionSchema.Type;
export type ContractFailure = typeof FailureSchema.Type;
export type ContractRecovery = Schema.Struct<typeof RecoveryFields>["Type"];
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

export const isSubagentContractTool = (tool: string): tool is SubagentContractTool =>
  Object.hasOwn(CONTRACT_SCHEMAS, tool);

export const decodeSubagentContract = <Tool extends SubagentContractTool>(tool: Tool) => {
  const schema: (typeof CONTRACT_SCHEMAS)[Tool] = CONTRACT_SCHEMAS[tool];
  return flow(
    decodeUnknownOrUndefined(schema, STRICT_PARSE_OPTIONS),
    (decoded): SubagentContract<Tool> | undefined =>
      decoded === undefined ? undefined : freezeSnapshot(decoded),
  );
};
