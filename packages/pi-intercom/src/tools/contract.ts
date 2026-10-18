import * as Schema from "effect/Schema";
import {
  DispositionSchema,
  MAX_CWD_CHARS,
  MAX_IDENTITY_CHARS,
  MAX_READ_BYTES,
  SessionStateSchema,
} from "../transport/protocol.ts";

export const SESSION_TOOL = {
  list: "session_list",
  send: "session_send",
  read: "session_read",
} as const;
export type SessionToolName = (typeof SESSION_TOOL)[keyof typeof SESSION_TOOL];
export const SESSION_TOOL_NAMES: ReadonlyArray<SessionToolName> = [
  SESSION_TOOL.list,
  SESSION_TOOL.send,
  SESSION_TOOL.read,
];

/** Arguments the session tools take; listing takes none. */
// A type alias, not an interface, so it fits the index signature of rendered arguments.
export type SessionToolArgs = {
  readonly to?: string;
  readonly message?: string;
};

export const INTERCOM_CONTRACT_ID = "pi-intercom/session";
const INTERCOM_CONTRACT_VERSION = 1;
/** Sessions one `session_list` result names; the rest are counted as omitted. */
export const MAX_LISTED_SESSIONS = 100;

const envelope = {
  contract: Schema.Literal(INTERCOM_CONTRACT_ID),
  version: Schema.Literal(INTERCOM_CONTRACT_VERSION),
};

const boundedString = (min: number, max: number) =>
  Schema.String.check(Schema.isMinLength(min), Schema.isMaxLength(max));

export const SessionViewSchema = Schema.Struct({
  sessionId: boundedString(1, MAX_IDENTITY_CHARS),
  name: Schema.optionalKey(boundedString(0, MAX_IDENTITY_CHARS)),
  cwd: boundedString(0, MAX_CWD_CHARS),
});
export type SessionView = typeof SessionViewSchema.Type;

export const ListedSessionSchema = Schema.Struct({
  ...SessionViewSchema.fields,
  state: Schema.Literals(["idle", "busy", "unresponsive"]).annotate({
    description: "unresponsive: the session didn't answer in time; it may be exiting or stuck.",
  }),
  duplicate: Schema.Boolean.annotate({
    description: "Another live session has the same sessionId, so neither can be addressed.",
  }),
});
export type ListedSession = typeof ListedSessionSchema.Type;

export const SessionListContractSchema = Schema.Struct({
  ...envelope,
  tool: Schema.Literal(SESSION_TOOL.list),
  sessions: Schema.Array(ListedSessionSchema).check(Schema.isMaxLength(MAX_LISTED_SESSIONS)),
  omitted: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type SessionListContract = typeof SessionListContractSchema.Type;

export const SessionReadContractSchema = Schema.Struct({
  ...envelope,
  tool: Schema.Literal(SESSION_TOOL.read),
  session: SessionViewSchema,
  /** Absent when the session has no assistant message yet. */
  text: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(MAX_READ_BYTES))),
  truncated: Schema.Boolean,
  state: SessionStateSchema,
});
export type SessionReadContract = typeof SessionReadContractSchema.Type;

const SessionSentSchema = Schema.Struct({
  ...envelope,
  tool: Schema.Literal(SESSION_TOOL.send),
  outcome: Schema.Literal("delivered"),
  session: SessionViewSchema,
  disposition: DispositionSchema,
});

/** The send's fate is unknown: the recipient may have taken the message. */
const SessionSendUncertainSchema = Schema.Struct({
  ...envelope,
  tool: Schema.Literal(SESSION_TOOL.send),
  outcome: Schema.Literal("uncertain"),
  session: SessionViewSchema,
  reason: Schema.Literals(["timeout", "disconnected", "protocol"]),
});

/**
 * Why a send or read didn't happen. The recipient's own refusals come first; the rest are decided
 * by the caller before or while connecting.
 */
export const ToolRefusalCodeSchema = Schema.Literals([
  "session_unavailable",
  "session_receive_disabled",
  "session_not_found",
  "session_ambiguous",
  "session_unreachable",
  "session_message_too_long",
]);
export type ToolRefusalCode = typeof ToolRefusalCodeSchema.Type;

const SessionRefusedSchema = Schema.Struct({
  ...envelope,
  tool: Schema.Literals([SESSION_TOOL.send, SESSION_TOOL.read]),
  outcome: Schema.Literal("refused"),
  code: ToolRefusalCodeSchema,
  to: boundedString(0, MAX_IDENTITY_CHARS),
  session: Schema.optionalKey(SessionViewSchema),
});

export const SessionToolDetailsSchema = Schema.Union([
  SessionListContractSchema,
  SessionReadContractSchema,
  SessionSentSchema,
  SessionSendUncertainSchema,
  SessionRefusedSchema,
]);
export type SessionToolDetails = typeof SessionToolDetailsSchema.Type;
export type SessionSendDetails = Extract<SessionToolDetails, { readonly tool: "session_send" }>;
export type SessionRefusal = typeof SessionRefusedSchema.Type;

export const decodeSessionToolDetails = Schema.decodeUnknownOption(SessionToolDetailsSchema);

export const contractEnvelope = {
  contract: INTERCOM_CONTRACT_ID,
  version: INTERCOM_CONTRACT_VERSION,
} as const;
