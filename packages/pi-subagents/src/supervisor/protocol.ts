import * as Schema from "effect/Schema";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import type { BackendEvent } from "../backend/model.ts";
import { MAX_PARENT_MESSAGE_CHARS } from "../run/limits.ts";
import {
  MAX_SUPERVISOR_MCP_DELIVERY_ID_CHARS,
  MAX_SUPERVISOR_MCP_MESSAGE_CHARS,
  MAX_SUPERVISOR_MCP_REPORT_CHARS,
  SUPERVISOR_MCP_DELIVERY_ID_PATTERN_SOURCE,
  SUPERVISOR_MCP_NONBLANK_PATTERN_SOURCE,
} from "./mcp-contract.ts";

export const SUPERVISOR_CHANNEL_VERSION = 2 as const;
export const MAX_SUPERVISOR_CHANNEL_ID_CHARS = 128;
export const MAX_SUPERVISOR_RUN_ID_CHARS = 80;
export const MAX_SUPERVISOR_CHANNEL_LINE_BYTES = 512 * 1024;
export const MAX_SUPERVISOR_CONFIG_BYTES = 4 * 1024;
export const SUPERVISOR_AUTH_TOKEN_CHARS = 64;

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const CHANNEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DELIVERY_ID_PATTERN = new RegExp(SUPERVISOR_MCP_DELIVERY_ID_PATTERN_SOURCE);
const NONBLANK_PATTERN = new RegExp(SUPERVISOR_MCP_NONBLANK_PATTERN_SOURCE);
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

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
export type SupervisorAuthToken = Schema.Schema.Type<typeof SupervisorAuthTokenSchema>;

export const SupervisorDeliveryIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_SUPERVISOR_MCP_DELIVERY_ID_CHARS),
  Schema.isPattern(DELIVERY_ID_PATTERN),
).pipe(Schema.brand("SupervisorDeliveryId"));
export type SupervisorDeliveryId = Schema.Schema.Type<typeof SupervisorDeliveryIdSchema>;

export const SupervisorAssignmentEpochSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThan(0),
);
export const SupervisorMessageSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_SUPERVISOR_MCP_MESSAGE_CHARS),
  Schema.isPattern(NONBLANK_PATTERN),
);
export const SupervisorReplySchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_PARENT_MESSAGE_CHARS),
);
export const SupervisorReportTextSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_SUPERVISOR_MCP_REPORT_CHARS),
  Schema.isPattern(NONBLANK_PATTERN),
);

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

export const SupervisorWatchAssignmentsRpc = Rpc.make("SupervisorWatchAssignments", {
  payload: AuthenticatedPayload,
  success: Schema.Struct({
    updateId: SupervisorChannelIdSchema,
    assignmentEpoch: SupervisorAssignmentEpochSchema,
  }),
  error: SupervisorRpcFailure,
  stream: true,
});

export const SupervisorAcknowledgeAssignmentRpc = Rpc.make("SupervisorAcknowledgeAssignment", {
  payload: {
    ...AssignedPayload,
    updateId: SupervisorChannelIdSchema,
  },
  error: SupervisorRpcFailure,
});

export const SupervisorProgressRpc = Rpc.make("SupervisorProgress", {
  payload: {
    ...AssignedPayload,
    requestId: SupervisorChannelIdSchema,
    message: SupervisorMessageSchema,
  },
  success: Schema.String,
  error: SupervisorRpcFailure,
});

export const SupervisorWarningRpc = Rpc.make("SupervisorWarning", {
  payload: {
    ...AssignedPayload,
    requestId: SupervisorChannelIdSchema,
    message: SupervisorMessageSchema,
  },
  success: Schema.String,
  error: SupervisorRpcFailure,
});

export const SupervisorQuestionRpc = Rpc.make("SupervisorQuestion", {
  payload: {
    ...AssignedPayload,
    requestId: SupervisorChannelIdSchema,
    message: SupervisorMessageSchema,
  },
  success: Schema.Struct({
    questionId: SupervisorChannelIdSchema,
    message: SupervisorReplySchema,
  }),
  error: SupervisorRpcFailure,
});

export const SupervisorAcknowledgeQuestionReplyRpc = Rpc.make(
  "SupervisorAcknowledgeQuestionReply",
  {
    payload: {
      ...AssignedPayload,
      questionId: SupervisorChannelIdSchema,
    },
    error: SupervisorRpcFailure,
  },
);

export const SupervisorReportRpc = Rpc.make("SupervisorReport", {
  payload: {
    ...AssignedPayload,
    requestId: SupervisorChannelIdSchema,
    deliveryId: SupervisorDeliveryIdSchema,
    text: SupervisorReportTextSchema,
  },
  success: Schema.Struct({
    duplicate: Schema.Boolean,
    sequence: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
    assignmentEpoch: SupervisorAssignmentEpochSchema,
  }),
  error: SupervisorRpcFailure,
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
);

export type SupervisorEvent = Extract<
  BackendEvent,
  { readonly type: "supervisor_contact" | "supervisor_question_cancelled" | "report" }
>;

export const validSupervisorReply = (value: string): boolean =>
  value.trim().length > 0 && value.length <= MAX_PARENT_MESSAGE_CHARS;
