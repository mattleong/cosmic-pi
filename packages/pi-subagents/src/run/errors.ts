import * as Schema from "effect/Schema";

export class InvalidSubagentRequestError extends Schema.TaggedErrorClass<InvalidSubagentRequestError>()(
  "InvalidSubagentRequestError",
  { message: Schema.String },
) {}

export class SubagentNotFoundError extends Schema.TaggedErrorClass<SubagentNotFoundError>()(
  "SubagentNotFoundError",
  { id: Schema.String, message: Schema.String },
) {}

export class SubagentCapacityError extends Schema.TaggedErrorClass<SubagentCapacityError>()(
  "SubagentCapacityError",
  { limit: Schema.Number, message: Schema.String },
) {}

export class SubagentWriterConflictError extends Schema.TaggedErrorClass<SubagentWriterConflictError>()(
  "SubagentWriterConflictError",
  { activeId: Schema.String, activeName: Schema.String, message: Schema.String },
) {}

export class SubagentProcessError extends Schema.TaggedErrorClass<SubagentProcessError>()(
  "SubagentProcessError",
  { operation: Schema.String, message: Schema.String },
) {}

export class SubagentProtocolError extends Schema.TaggedErrorClass<SubagentProtocolError>()(
  "SubagentProtocolError",
  { message: Schema.String },
) {}

export class SubagentRuntimeClosedError extends Schema.TaggedErrorClass<SubagentRuntimeClosedError>()(
  "SubagentRuntimeClosedError",
  { message: Schema.String },
) {}

export class UnsupportedSubagentCapabilityError extends Schema.TaggedErrorClass<UnsupportedSubagentCapabilityError>()(
  "UnsupportedSubagentCapabilityError",
  { backend: Schema.String, capability: Schema.String, message: Schema.String },
) {}

export type SubagentError =
  | InvalidSubagentRequestError
  | SubagentNotFoundError
  | SubagentCapacityError
  | SubagentWriterConflictError
  | SubagentProcessError
  | SubagentProtocolError
  | SubagentRuntimeClosedError
  | UnsupportedSubagentCapabilityError;
