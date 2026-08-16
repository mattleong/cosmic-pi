import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { BackendEvent } from "../backend/model.ts";
import { MAX_BACKEND_REPORT_ID_CHARS, MAX_BACKEND_REPORT_TEXT_CHARS } from "../backend/model.ts";
import { MAX_PARENT_MESSAGE_CHARS } from "../run/limits.ts";

export const SUPERVISOR_CHANNEL_VERSION = 1 as const;
export const SUPERVISOR_MCP_SERVER_NAME = "pi_subagents_supervisor" as const;
export const MAX_SUPERVISOR_MESSAGE_CHARS = 16 * 1024;
export const MAX_SUPERVISOR_CHANNEL_ID_CHARS = 128;
export const MAX_SUPERVISOR_RUN_ID_CHARS = 80;
export const MAX_SUPERVISOR_CHANNEL_LINE_BYTES = 512 * 1024;
export const MAX_SUPERVISOR_CONFIG_BYTES = 4 * 1024;
export const SUPERVISOR_AUTH_TOKEN_CHARS = 64;

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const CHANNEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DELIVERY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
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
const TokenSchema = Schema.String.check(
  Schema.isMinLength(SUPERVISOR_AUTH_TOKEN_CHARS),
  Schema.isMaxLength(SUPERVISOR_AUTH_TOKEN_CHARS),
  Schema.isPattern(TOKEN_PATTERN),
);
export const SupervisorDeliveryIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_BACKEND_REPORT_ID_CHARS),
  Schema.isPattern(DELIVERY_ID_PATTERN),
).pipe(Schema.brand("SupervisorDeliveryId"));
export type SupervisorDeliveryId = Schema.Schema.Type<typeof SupervisorDeliveryIdSchema>;
const AssignmentEpochSchema = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));
const MessageSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_SUPERVISOR_MESSAGE_CHARS),
);
const ReportTextSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_BACKEND_REPORT_TEXT_CHARS),
);

const AuthenticatedFields = {
  version: Schema.Literal(SUPERVISOR_CHANNEL_VERSION),
  runId: SupervisorRunIdSchema,
  token: TokenSchema,
};
const RequestFields = {
  ...AuthenticatedFields,
  id: SupervisorChannelIdSchema,
};
const AssignmentFields = {
  ...RequestFields,
  assignmentEpoch: AssignmentEpochSchema,
};

export const SupervisorChannelConfigSchema = Schema.Struct({
  version: Schema.Literal(SUPERVISOR_CHANNEL_VERSION),
  runId: SupervisorRunIdSchema,
  host: Schema.Literal("127.0.0.1"),
  port: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(65_535),
  ),
  token: TokenSchema,
});

export type SupervisorChannelConfig = Schema.Schema.Type<typeof SupervisorChannelConfigSchema>;

export interface SupervisorServerAuthentication {
  readonly version: typeof SUPERVISOR_CHANNEL_VERSION;
  readonly runId: SupervisorRunId;
  readonly token: string;
}

export type SupervisorServerPayload =
  | {
      readonly type: "hello_ok";
      readonly id: SupervisorChannelId;
      readonly assignmentEpoch: number;
    }
  | {
      readonly type: "assignment_epoch";
      readonly id: SupervisorChannelId;
      readonly assignmentEpoch: number;
    }
  | {
      readonly type: "result";
      readonly id: SupervisorChannelId;
      readonly accepted: true;
      readonly duplicate?: boolean | undefined;
      readonly sequence?: number | undefined;
      readonly assignmentEpoch?: number | undefined;
    }
  | {
      readonly type: "error";
      readonly id: SupervisorChannelId | null;
      readonly code: string;
      readonly message: string;
    }
  | {
      readonly type: "question_reply";
      readonly id: SupervisorChannelId;
      readonly message: string;
    }
  | { readonly type: "cancelled"; readonly id: SupervisorChannelId }
  | {
      readonly type: "cancel_result";
      readonly id: SupervisorChannelId;
      readonly targetRequestId: SupervisorChannelId;
      readonly cancelled: boolean;
    }
  | { readonly type: "closed" };

export type SupervisorServerMessage = SupervisorServerPayload & SupervisorServerAuthentication;

export const authenticateSupervisorServerPayload = <Payload extends SupervisorServerPayload>(
  authentication: SupervisorServerAuthentication,
  payload: Payload,
): Payload & SupervisorServerAuthentication => ({
  ...payload,
  version: authentication.version,
  runId: authentication.runId,
  token: authentication.token,
});

const HelloSchema = Schema.Struct({
  ...RequestFields,
  type: Schema.Literal("hello"),
});
const ProgressSchema = Schema.Struct({
  ...AssignmentFields,
  type: Schema.Literal("progress"),
  message: MessageSchema,
});
const WarningSchema = Schema.Struct({
  ...AssignmentFields,
  type: Schema.Literal("warning"),
  message: MessageSchema,
});
const QuestionSchema = Schema.Struct({
  ...AssignmentFields,
  type: Schema.Literal("question"),
  message: MessageSchema,
});
const ReportSchema = Schema.Struct({
  ...AssignmentFields,
  type: Schema.Literal("report"),
  deliveryId: SupervisorDeliveryIdSchema,
  text: ReportTextSchema,
});
const CancelSchema = Schema.Struct({
  ...RequestFields,
  type: Schema.Literal("cancel"),
  targetRequestId: SupervisorChannelIdSchema,
});
const QuestionReplyAckSchema = Schema.Struct({
  ...RequestFields,
  type: Schema.Literal("question_reply_ack"),
  questionId: SupervisorChannelIdSchema,
});
const AssignmentEpochAckSchema = Schema.Struct({
  ...RequestFields,
  type: Schema.Literal("assignment_epoch_ack"),
  assignmentEpoch: AssignmentEpochSchema,
});

export const SupervisorClientMessageSchema = Schema.Union([
  HelloSchema,
  ProgressSchema,
  WarningSchema,
  QuestionSchema,
  ReportSchema,
  CancelSchema,
  QuestionReplyAckSchema,
  AssignmentEpochAckSchema,
]);

export type SupervisorClientMessage = Schema.Schema.Type<typeof SupervisorClientMessageSchema>;

const exactDecodeOptions = { onExcessProperty: "error" as const };

export const decodeSupervisorClientMessage = <ValueInput>(
  value: ValueInput,
): SupervisorClientMessage | undefined => {
  const decoded = Schema.decodeUnknownOption(
    SupervisorClientMessageSchema,
    exactDecodeOptions,
  )(value);
  return Option.isSome(decoded) ? decoded.value : undefined;
};

export type SupervisorEvent = Extract<
  BackendEvent,
  { readonly type: "supervisor_contact" | "supervisor_question_cancelled" | "report" }
>;

export const validSupervisorMessage = (value: string): boolean =>
  value.trim().length > 0 && value.length <= MAX_SUPERVISOR_MESSAGE_CHARS;
export const validSupervisorReply = (value: string): boolean =>
  value.trim().length > 0 && value.length <= MAX_PARENT_MESSAGE_CHARS;
export const validSupervisorReport = (value: string): boolean =>
  value.trim().length > 0 && value.length <= MAX_BACKEND_REPORT_TEXT_CHARS;
