import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import type { BackendEvent } from "../backend/model.ts";
import { MAX_RUN_READ_CHARS } from "../run/agent-messaging.ts";
import { MAX_PARENT_MESSAGE_CHARS } from "../run/limits.ts";
import {
  MAX_SUPERVISOR_MCP_AGENT_ID_CHARS,
  MAX_SUPERVISOR_MCP_AGENT_IDS,
  MAX_SUPERVISOR_MCP_DELIVERY_ID_CHARS,
  MAX_SUPERVISOR_MCP_MESSAGE_CHARS,
  MAX_SUPERVISOR_MCP_REPORT_CHARS,
  MAX_SUPERVISOR_MCP_THREAD_ID_CHARS,
  SUPERVISOR_MCP_AGENT_ID_PATTERN_SOURCE,
  SUPERVISOR_MCP_DELIVERY_ID_PATTERN_SOURCE,
  SUPERVISOR_MCP_NONBLANK_PATTERN_SOURCE,
} from "./mcp-contract.ts";

export const SUPERVISOR_CHANNEL_VERSION = 3 as const;
const MAX_SUPERVISOR_CHANNEL_ID_CHARS = 128;
const MAX_SUPERVISOR_RUN_ID_CHARS = 80;
export const MAX_SUPERVISOR_CHANNEL_LINE_BYTES = 3 * 1024 * 1024;
export const MAX_SUPERVISOR_CONFIG_BYTES = 4 * 1024;
const SUPERVISOR_AUTH_TOKEN_CHARS = 64;

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const CHANNEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DELIVERY_ID_PATTERN = new RegExp(SUPERVISOR_MCP_DELIVERY_ID_PATTERN_SOURCE);
const NONBLANK_PATTERN = new RegExp(SUPERVISOR_MCP_NONBLANK_PATTERN_SOURCE);
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const AGENT_ID_PATTERN = new RegExp(SUPERVISOR_MCP_AGENT_ID_PATTERN_SOURCE);

export const SupervisorRunIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_SUPERVISOR_RUN_ID_CHARS),
  Schema.isPattern(RUN_ID_PATTERN),
).pipe(Schema.brand("SupervisorRunId"));
export type SupervisorRunId = Schema.Schema.Type<typeof SupervisorRunIdSchema>;

export const SupervisorChannelIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_SUPERVISOR_CHANNEL_ID_CHARS),
  Schema.isPattern(CHANNEL_ID_PATTERN),
).pipe(Schema.brand("SupervisorChannelId"));
export type SupervisorChannelId = Schema.Schema.Type<typeof SupervisorChannelIdSchema>;

export const isSupervisorRunId = (value: string): value is SupervisorRunId =>
  RUN_ID_PATTERN.test(value);

export const SupervisorAuthTokenSchema = Schema.String.check(
  Schema.isMinLength(SUPERVISOR_AUTH_TOKEN_CHARS),
  Schema.isMaxLength(SUPERVISOR_AUTH_TOKEN_CHARS),
  Schema.isPattern(TOKEN_PATTERN),
).pipe(Schema.brand("SupervisorAuthToken"));

export const SupervisorDeliveryIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_SUPERVISOR_MCP_DELIVERY_ID_CHARS),
  Schema.isPattern(DELIVERY_ID_PATTERN),
).pipe(Schema.brand("SupervisorDeliveryId"));
export type SupervisorDeliveryId = Schema.Schema.Type<typeof SupervisorDeliveryIdSchema>;

const SupervisorAssignmentEpochSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThan(0),
);
const nonblankText = (maximum: number) =>
  Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(maximum),
    Schema.isPattern(NONBLANK_PATTERN),
  );
export const SupervisorMessageSchema = nonblankText(MAX_SUPERVISOR_MCP_MESSAGE_CHARS);
export const PARENT_REPLY_PREFIX = "Parent reply: ";

const SupervisorReplySchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_PARENT_MESSAGE_CHARS),
);
export const SupervisorReportTextSchema = nonblankText(MAX_SUPERVISOR_MCP_REPORT_CHARS);
export const SupervisorChannelConfigSchema = Schema.Struct({
  version: Schema.Literal(SUPERVISOR_CHANNEL_VERSION),
  runId: SupervisorRunIdSchema,
  host: Schema.Literal("127.0.0.1"),
  port: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(65_535),
  ),
  token: SupervisorAuthTokenSchema,
});
export type SupervisorChannelConfig = Schema.Schema.Type<typeof SupervisorChannelConfigSchema>;

const AuthenticatedPayload = {
  version: Schema.Literal(SUPERVISOR_CHANNEL_VERSION),
  runId: SupervisorRunIdSchema,
  token: SupervisorAuthTokenSchema,
};
const AssignedPayload = {
  ...AuthenticatedPayload,
  assignmentEpoch: SupervisorAssignmentEpochSchema,
};
const MessagePayload = {
  ...AssignedPayload,
  requestId: SupervisorChannelIdSchema,
  message: SupervisorMessageSchema,
};
/** The native thread that made a main-agent-only call, when the runtime identifies it. */
const MainAgentCallPayload = {
  nativeThreadId: Schema.optional(
    Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(MAX_SUPERVISOR_MCP_THREAD_ID_CHARS),
    ),
  ),
};

export class SupervisorRpcFailure extends Schema.TaggedError<SupervisorRpcFailure>()(
  "SupervisorRpcFailure",
  {
    code: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
    message: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  },
) {}

export const SupervisorOpenSessionRpc = Rpc.make("SupervisorOpenSession", {
  payload: AuthenticatedPayload,
  success: Schema.Struct({
    assignmentEpoch: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  }),
  error: SupervisorRpcFailure,
});

const SupervisorWatchAssignmentsRpc = Rpc.make("SupervisorWatchAssignments", {
  payload: AuthenticatedPayload,
  success: Schema.Struct({
    kind: Schema.Literal("assignment"),
    updateId: SupervisorChannelIdSchema,
    assignmentEpoch: SupervisorAssignmentEpochSchema,
  }),
  error: SupervisorRpcFailure,
  stream: true,
});

const SupervisorAcknowledgeAssignmentRpc = Rpc.make("SupervisorAcknowledgeAssignment", {
  payload: {
    ...AssignedPayload,
    updateId: SupervisorChannelIdSchema,
  },
  error: SupervisorRpcFailure,
});

const contactRpc = <const Tag extends string>(tag: Tag) =>
  Rpc.make(tag, {
    payload: { ...MessagePayload, ...MainAgentCallPayload },
    success: Schema.String,
    error: SupervisorRpcFailure,
  });
export const SupervisorProgressRpc = contactRpc("SupervisorProgress");
const SupervisorWarningRpc = contactRpc("SupervisorWarning");

const SupervisorQuestionRpc = Rpc.make("SupervisorQuestion", {
  payload: { ...MessagePayload, ...MainAgentCallPayload },
  success: Schema.Struct({
    questionId: SupervisorChannelIdSchema,
    message: SupervisorReplySchema,
  }),
  error: SupervisorRpcFailure,
});

const SupervisorAcknowledgeQuestionReplyRpc = Rpc.make("SupervisorAcknowledgeQuestionReply", {
  payload: {
    ...AssignedPayload,
    questionId: SupervisorChannelIdSchema,
  },
  error: SupervisorRpcFailure,
});

const SupervisorReportRpc = Rpc.make("SupervisorReport", {
  payload: {
    ...AssignedPayload,
    requestId: SupervisorChannelIdSchema,
    deliveryId: SupervisorDeliveryIdSchema,
    text: SupervisorReportTextSchema,
    ...MainAgentCallPayload,
  },
  success: Schema.Struct({
    duplicate: Schema.Boolean,
    sequence: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
    assignmentEpoch: SupervisorAssignmentEpochSchema,
  }),
  error: SupervisorRpcFailure,
});

/** A refusal the child's model can act on, such as an unknown agent. */
export class SupervisorAgentRefusal extends Schema.TaggedError<SupervisorAgentRefusal>()(
  "SupervisorAgentRefusal",
  {
    code: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
    message: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  },
) {}

export const MAX_SUPERVISOR_AGENT_NAME_CHARS = 128;
/** A run's whole retained message or report; main's longer message is cut here. */
export const MAX_SUPERVISOR_AGENT_READ_CHARS = MAX_RUN_READ_CHARS;
export const MAX_SUPERVISOR_AGENT_FACT_CHARS = 512;
/**
 * A card leads with its header and whole pending question, so this keeps them; a longer card is
 * cut with a marker. JSON spends up to six bytes on one UTF-16 unit, since a lone surrogate
 * survives sanitizing and is written as `\ud800`. Twelve cards and texts, 12 × (24,576 + 16,640)
 * × 6 bytes ≈ 2.83 MiB, leave room for names, IDs, and envelopes below both the 3 MiB channel
 * line and the 4 MiB CLI stdout line, where Claude stream-json and Codex items echo the result.
 */
export const MAX_SUPERVISOR_AGENT_CARD_CHARS = 24 * 1024;
const boundedFact = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_SUPERVISOR_AGENT_FACT_CHARS),
);
const boundedLabel = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_SUPERVISOR_AGENT_NAME_CHARS),
);
const AgentStateSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32));
export const SupervisorAgentIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_SUPERVISOR_MCP_AGENT_ID_CHARS),
  Schema.isPattern(AGENT_ID_PATTERN),
);
const AgentIdsSchema = Schema.Array(SupervisorAgentIdSchema).check(
  Schema.isMaxLength(MAX_SUPERVISOR_MCP_AGENT_IDS),
);
const AgentRefusalError = Schema.Union([SupervisorRpcFailure, SupervisorAgentRefusal]);

const SupervisorAgentListRpc = Rpc.make("SupervisorAgentList", {
  payload: { ...AssignedPayload, ids: Schema.optional(AgentIdsSchema) },
  success: Schema.Struct({
    agents: Schema.Array(
      Schema.Struct({
        id: SupervisorAgentIdSchema,
        name: boundedLabel,
        kind: Schema.Literals(["main", "run"]),
        state: AgentStateSchema,
        parentId: Schema.optional(SupervisorAgentIdSchema),
        runtime: Schema.optional(boundedLabel),
        model: Schema.optional(boundedFact),
        profile: Schema.optional(boundedLabel),
        agent: Schema.optional(boundedLabel),
        /** A worktree writer's tree or proposal, with how its parent applies it. */
        worktree: Schema.optional(boundedFact),
        /** Whether the run waits on its parent. */
        attention: Schema.optional(boundedFact),
        self: Schema.Boolean,
      }),
    ),
    missingIds: AgentIdsSchema,
  }),
  error: AgentRefusalError,
});

const SupervisorAgentSendRpc = Rpc.make("SupervisorAgentSend", {
  payload: {
    ...AssignedPayload,
    to: SupervisorAgentIdSchema,
    message: SupervisorMessageSchema,
    ...MainAgentCallPayload,
  },
  success: Schema.Struct({
    messageId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
    to: SupervisorAgentIdSchema,
    name: boundedLabel,
    disposition: Schema.Literals([
      "answered",
      "guided",
      "pending",
      "resumed",
      "woken",
      "queued",
      "held",
    ]),
  }),
  error: AgentRefusalError,
});

const SupervisorAgentReadRpc = Rpc.make("SupervisorAgentRead", {
  payload: {
    ...AssignedPayload,
    ids: AgentIdsSchema.check(Schema.isMinLength(1)),
    verbose: Schema.optional(Schema.Boolean),
  },
  success: Schema.Struct({
    agents: Schema.Array(
      Schema.Struct({
        id: SupervisorAgentIdSchema,
        name: boundedLabel,
        state: AgentStateSchema,
        /** A run's status card. */
        card: Schema.optional(
          Schema.String.check(Schema.isMaxLength(MAX_SUPERVISOR_AGENT_CARD_CHARS)),
        ),
        text: Schema.optional(
          Schema.String.check(Schema.isMaxLength(MAX_SUPERVISOR_AGENT_READ_CHARS)),
        ),
        truncated: Schema.Boolean,
        source: Schema.optional(Schema.Literals(["assistant", "report", "error"])),
      }),
    ),
    missingIds: AgentIdsSchema,
  }),
  error: AgentRefusalError,
});

export const SupervisorRpcGroup = RpcGroup.make(
  SupervisorOpenSessionRpc,
  SupervisorWatchAssignmentsRpc,
  SupervisorAcknowledgeAssignmentRpc,
  SupervisorProgressRpc,
  SupervisorWarningRpc,
  SupervisorQuestionRpc,
  SupervisorAcknowledgeQuestionReplyRpc,
  SupervisorReportRpc,
  SupervisorAgentListRpc,
  SupervisorAgentSendRpc,
  SupervisorAgentReadRpc,
);

export type SupervisorAgentListResult = typeof SupervisorAgentListRpc.successSchema.Type;
export type SupervisorAgentSendResult = typeof SupervisorAgentSendRpc.successSchema.Type;
export type SupervisorAgentReadResult = typeof SupervisorAgentReadRpc.successSchema.Type;

export type SupervisorEvent = Extract<
  BackendEvent,
  {
    readonly type: "supervisor_contact" | "parent_question_cancelled" | "report";
  }
>;

export const validSupervisorReply = (value: string): boolean =>
  value.trim().length > 0 && value.length <= MAX_PARENT_MESSAGE_CHARS;
