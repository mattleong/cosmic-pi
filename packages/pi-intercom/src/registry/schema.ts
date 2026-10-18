import * as Schema from "effect/Schema";

const RECORD_VERSION = 1 as const;

/** 128-bit runtime instance, in lowercase hex. */
export const INSTANCE_BYTES = 16;
/** 256-bit socket token, in lowercase hex. */
export const TOKEN_BYTES = 32;

const hex = (bytes: number) =>
  Schema.String.check(Schema.isPattern(new RegExp(`^[0-9a-f]{${bytes * 2}}$`)));

const ProcessId = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));

const InstanceId = hex(INSTANCE_BYTES);

/** One live session runtime, as `<agentDir>/intercom/sessions/<instance>.json` describes it. */
export const SessionRecordSchema = Schema.Struct({
  version: Schema.Literal(RECORD_VERSION),
  instance: InstanceId,
  pid: ProcessId,
  /** The owner's OS start identity; without it liveness stays unknown and the record is kept. */
  started: Schema.optionalKey(Schema.String),
  sessionId: Schema.String.check(Schema.isMinLength(1)),
  name: Schema.optionalKey(Schema.String),
  cwd: Schema.String,
  socket: Schema.String.check(Schema.isMinLength(1)),
  token: hex(TOKEN_BYTES),
});

export type SessionRecord = typeof SessionRecordSchema.Type;

export const SessionRecordFromJson = Schema.fromJsonString(SessionRecordSchema);

/** Names the runtime that created a fallback socket directory, so a sweep can tell it is dead. */
export const SocketOwnerSchema = Schema.Struct({
  version: Schema.Literal(RECORD_VERSION),
  instance: InstanceId,
  pid: ProcessId,
  started: Schema.optionalKey(Schema.String),
});

export const SocketOwnerFromJson = Schema.fromJsonString(SocketOwnerSchema);

export interface SessionRecordInput {
  readonly instance: string;
  readonly pid: number;
  readonly started: string | undefined;
  readonly sessionId: string;
  readonly name: string | undefined;
  readonly cwd: string;
  readonly socket: string;
  readonly token: string;
}

export const sessionRecord = (input: SessionRecordInput): SessionRecord => ({
  version: RECORD_VERSION,
  instance: input.instance,
  pid: input.pid,
  ...(input.started !== undefined && { started: input.started }),
  sessionId: input.sessionId,
  ...(input.name !== undefined && { name: input.name }),
  cwd: input.cwd,
  socket: input.socket,
  token: input.token,
});

export const socketOwner = (
  instance: string,
  pid: number,
  started: string | undefined,
): typeof SocketOwnerSchema.Type => ({
  version: RECORD_VERSION,
  instance,
  pid,
  ...(started !== undefined && { started }),
});
