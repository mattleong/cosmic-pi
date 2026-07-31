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

export const isSupervisorRunId = (value: string): boolean => RUN_ID_PATTERN.test(value);
export const isSupervisorChannelId = (value: string): boolean => CHANNEL_ID_PATTERN.test(value);
export const isSupervisorDeliveryId = (value: string): boolean =>
  DELIVERY_ID_PATTERN.test(value) && value.length <= MAX_BACKEND_REPORT_ID_CHARS;

const RunIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_SUPERVISOR_RUN_ID_CHARS),
  Schema.isPattern(RUN_ID_PATTERN),
);
const ChannelIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_SUPERVISOR_CHANNEL_ID_CHARS),
  Schema.isPattern(CHANNEL_ID_PATTERN),
);
const TokenSchema = Schema.String.check(
  Schema.isMinLength(SUPERVISOR_AUTH_TOKEN_CHARS),
  Schema.isMaxLength(SUPERVISOR_AUTH_TOKEN_CHARS),
  Schema.isPattern(TOKEN_PATTERN),
);
const DeliveryIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_BACKEND_REPORT_ID_CHARS),
  Schema.isPattern(DELIVERY_ID_PATTERN),
);
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
  runId: RunIdSchema,
  token: TokenSchema,
};
const RequestFields = {
  ...AuthenticatedFields,
  id: ChannelIdSchema,
};
const AssignmentFields = {
  ...RequestFields,
  assignmentEpoch: AssignmentEpochSchema,
};

export const SupervisorChannelConfigSchema = Schema.Struct({
  version: Schema.Literal(SUPERVISOR_CHANNEL_VERSION),
  runId: RunIdSchema,
  host: Schema.Literal("127.0.0.1"),
  port: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(65_535),
  ),
  token: TokenSchema,
});

export type SupervisorChannelConfig = Schema.Schema.Type<typeof SupervisorChannelConfigSchema>;

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
  deliveryId: DeliveryIdSchema,
  text: ReportTextSchema,
});
const CancelSchema = Schema.Struct({
  ...RequestFields,
  type: Schema.Literal("cancel"),
  targetRequestId: ChannelIdSchema,
});
const QuestionReplyAckSchema = Schema.Struct({
  ...RequestFields,
  type: Schema.Literal("question_reply_ack"),
  questionId: ChannelIdSchema,
});
const AssignmentEpochAckSchema = Schema.Struct({
  ...RequestFields,
  type: Schema.Literal("assignment_epoch_ack"),
  assignmentEpoch: AssignmentEpochSchema,
});

export type SupervisorClientMessage =
  | Schema.Schema.Type<typeof HelloSchema>
  | Schema.Schema.Type<typeof ProgressSchema>
  | Schema.Schema.Type<typeof WarningSchema>
  | Schema.Schema.Type<typeof QuestionSchema>
  | Schema.Schema.Type<typeof ReportSchema>
  | Schema.Schema.Type<typeof CancelSchema>
  | Schema.Schema.Type<typeof QuestionReplyAckSchema>
  | Schema.Schema.Type<typeof AssignmentEpochAckSchema>;

const DiscriminantSchema = Schema.Struct({ type: Schema.optional(Schema.String) });
const exactDecodeOptions = { onExcessProperty: "error" as const };

export const decodeSupervisorClientMessage = (
  value: unknown,
): SupervisorClientMessage | undefined => {
  const discriminant = Schema.decodeUnknownOption(DiscriminantSchema)(value);
  if (Option.isNone(discriminant)) return undefined;
  const schema = (() => {
    switch (discriminant.value.type) {
      case "hello":
        return HelloSchema;
      case "progress":
        return ProgressSchema;
      case "warning":
        return WarningSchema;
      case "question":
        return QuestionSchema;
      case "report":
        return ReportSchema;
      case "cancel":
        return CancelSchema;
      case "question_reply_ack":
        return QuestionReplyAckSchema;
      case "assignment_epoch_ack":
        return AssignmentEpochAckSchema;
      default:
        return undefined;
    }
  })();
  if (!schema) return undefined;
  const decoded = Schema.decodeUnknownOption(schema, exactDecodeOptions)(value);
  return Option.isSome(decoded) ? (decoded.value as SupervisorClientMessage) : undefined;
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
