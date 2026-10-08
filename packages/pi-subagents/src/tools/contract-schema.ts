/**
 * Version-1 machine-readable orchestration contracts for scripts. These are separate from the
 * persisted/display details: they carry only domain facts, never formatted text, and decode
 * strictly so an unexpected key is a mismatch rather than silently ignored metadata.
 */
import * as Schema from "effect/Schema";
import { decodeUnknownOrUndefined, freezeSnapshot } from "pi-cosmic-core";
import { PROFILE_CANDIDATE_WRITE_INTENTS, PROFILE_IDS } from "../profiles/model.ts";
import {
  MAX_PROTOCOL_ID_CHARS,
  MAX_START_BATCH,
  MAX_TARGET_RUNS,
  MAX_TOOL_OUTPUT_CHARS,
} from "../run/limits.ts";
import {
  FAILED_START_CLEANUP_DISPOSITIONS,
  FAILED_START_RETRY_DISPOSITIONS,
  PI_SUBAGENT_CAPABILITIES,
  SUBAGENT_RUN_STATES,
} from "../run/model.ts";
import { MAX_NAME_CHARS } from "../run/state.ts";
import { SUBAGENT_TOOL_NAME } from "../run/tool-policy.ts";
import { MAX_CARD_QUESTION_CHARS, MAX_FAILURE_CODE_CHARS, NonEmptyText } from "./details-schema.ts";
import type { ActionFailureDisposition } from "./outcome.ts";
import { AWAIT_UNTIL, type SubagentLifecycleInput } from "./schema.ts";

export const SUBAGENT_CONTRACT_ID = "pi-subagents/orchestration";
export const SUBAGENT_CONTRACT_VERSION = 1;
/** A fully rendered report always fits one bounded tool output, so delivery never truncates. */
export const MAX_CONTRACT_REPORT_CHARS = MAX_TOOL_OUTPUT_CHARS;
export const MAX_CONTRACT_MESSAGE_CHARS = 1_024;
export const MAX_CONTRACT_ERROR_CHARS = 2_048;
export const MAX_CONTRACT_QUESTION_CHARS = MAX_CARD_QUESTION_CHARS;

const LIFECYCLE_ACTIONS = ["resume", "interrupt", "stop", "retry"] as const satisfies ReadonlyArray<
  SubagentLifecycleInput["action"]
>;
const FAILURE_DISPOSITIONS = [
  "pending",
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

/** Report dispositions that never carry text. Every omission is named; none is silent. */
const WITHHELD_REPORT_STATUSES = [
  /** Finished but not delivered by this call; the report stays unconsumed for later delivery. */
  "deferred",
  /** Another operation owns this generation. */
  "claimed",
  "already_delivered",
  "missing",
  "not_finished",
  /** No report facts were observed (for example, a lifecycle receipt). */
  "unknown",
] as const;

const WithheldReportSchema = Schema.Struct({ status: Schema.Literals(WITHHELD_REPORT_STATUSES) });
const ReportSchema = Schema.Union([
  /** `delivered` consumes this call's owned receipt; `read_back` is opt-in and consumes nothing. */
  Schema.Struct({
    status: Schema.Literals(["delivered", "read_back"]),
    text: NonEmptyText(MAX_CONTRACT_REPORT_CHARS),
  }),
  WithheldReportSchema,
]);

/** Mirrors `runAttention`; the projection's assignment keeps both in step. */
const AttentionSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literals(["containment", "admission-paused", "question-unavailable"]),
  }),
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
    state: StateSchema,
    /** The current assignment has settled; backend resources may still be closing. */
    finished: Schema.Boolean,
    reportGeneration: count,
    writeIntent: WriteIntentSchema,
    capabilities: Schema.Array(Schema.Literals(PI_SUBAGENT_CAPABILITIES)).check(
      Schema.isMaxLength(PI_SUBAGENT_CAPABILITIES.length),
    ),
    predecessorRunId: Schema.optionalKey(RunIdSchema),
    successorRunId: Schema.optionalKey(RunIdSchema),
    parentActionRequired: Schema.Boolean,
    attention: Schema.optionalKey(AttentionSchema),
    /** Authoritative failed-start recovery only; never inferred from run-view hints. */
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
  /** Request-ordered launches, one per requested agent. */
  launches: Schema.Array(
    Schema.Union([
      Schema.Struct({
        index: count,
        status: Schema.Literal("started"),
        runId: RunIdSchema,
        name: NameSchema,
        profile: Schema.optionalKey(ProfileSchema),
        state: StateSchema,
        writeIntent: WriteIntentSchema,
      }),
      Schema.Struct({
        index: count,
        status: Schema.Literal("failed"),
        name: Schema.optionalKey(NameSchema),
        profile: Schema.optionalKey(ProfileSchema),
        failure: FailureSchema,
        /** Settled cleanup and retry facts when launch admission had already created a run. */
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
  /** Cancellation never carries or consumes report text. */
  Schema.Struct({
    ...awaitFields,
    outcome: Schema.Literal("cancelled"),
    targets: Schema.Array(WithheldRunTargetSchema).check(Schema.isMaxLength(MAX_TARGET_RUNS)),
    unobservedRunIds: RunIdsSchema,
    cleanup: Schema.Literals(["confirmed", "unconfirmed"]),
  }),
]);

const StatusContractSchema = Schema.Struct({
  ...envelope(SUBAGENT_TOOL_NAME.status),
  targets: RunTargetsSchema,
  missingRunIds: RunIdsSchema,
});

const LifecycleContractSchema = Schema.Struct({
  ...envelope(SUBAGENT_TOOL_NAME.lifecycle),
  action: Schema.Literals(LIFECYCLE_ACTIONS),
  outcome: Schema.Literals(["succeeded", "partial", "failed"]),
  /** Request-ordered. A retry's requested predecessor and new successor stay separate IDs. */
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

/** The one contract catalog, keyed by exact public tool name. */
export const CONTRACT_SCHEMAS = {
  [SUBAGENT_TOOL_NAME.start]: StartContractSchema,
  [SUBAGENT_TOOL_NAME.await]: AwaitContractSchema,
  [SUBAGENT_TOOL_NAME.status]: StatusContractSchema,
  [SUBAGENT_TOOL_NAME.lifecycle]: LifecycleContractSchema,
} as const;

export type SubagentContractTool = keyof typeof CONTRACT_SCHEMAS;
export type SubagentContract<Tool extends SubagentContractTool = SubagentContractTool> =
  (typeof CONTRACT_SCHEMAS)[Tool]["Type"];
export type SubagentStartContract = SubagentContract<typeof SUBAGENT_TOOL_NAME.start>;
export type SubagentAwaitContract = SubagentContract<typeof SUBAGENT_TOOL_NAME.await>;
export type SubagentStatusContract = SubagentContract<typeof SUBAGENT_TOOL_NAME.status>;
export type SubagentLifecycleContract = SubagentContract<typeof SUBAGENT_TOOL_NAME.lifecycle>;
export type ContractRunTarget = typeof RunTargetSchema.Type;
export type ContractReport = typeof ReportSchema.Type;
export type ContractWithheldReport = typeof WithheldReportSchema.Type;
export type ContractAttention = typeof AttentionSchema.Type;
export type ContractFailure = typeof FailureSchema.Type;
export type ContractRecovery = Schema.Struct<typeof RecoveryFields>["Type"];
export type ContractStartLaunch = SubagentStartContract["launches"][number];
export type ContractLifecycleResult = SubagentLifecycleContract["results"][number];
export type ContractLifecycleAction = SubagentLifecycleContract["action"];

const STRICT_PARSE_OPTIONS = { errors: "first", onExcessProperty: "error" } as const;

/** JSON encoding validates producers before completion receipts can be consumed. */
export const SubagentContractSchema = Schema.Union([
  StartContractSchema,
  AwaitContractSchema,
  StatusContractSchema,
  LifecycleContractSchema,
]);
export const encodeSubagentContract = Schema.encodeSync(
  Schema.toCodecJson(SubagentContractSchema),
  STRICT_PARSE_OPTIONS,
);

export const isSubagentContractTool = (tool: string): tool is SubagentContractTool =>
  Object.hasOwn(CONTRACT_SCHEMAS, tool);

/** Strict decode of one tool's contract; any mismatch, excess key, or hostile value is undefined. */
export const decodeSubagentContract = <Tool extends SubagentContractTool, ValueInput>(
  tool: Tool,
  value: ValueInput,
): SubagentContract<Tool> | undefined => {
  const schema: (typeof CONTRACT_SCHEMAS)[Tool] = CONTRACT_SCHEMAS[tool];
  const decoded = decodeUnknownOrUndefined(schema, value, STRICT_PARSE_OPTIONS);
  return decoded === undefined ? undefined : freezeSnapshot(decoded);
};
