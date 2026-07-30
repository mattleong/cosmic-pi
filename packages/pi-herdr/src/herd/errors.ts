import * as Schema from "effect/Schema";

export class HerdrUnavailableError extends Schema.TaggedErrorClass<HerdrUnavailableError>()(
  "HerdrUnavailableError",
  { code: Schema.String, message: Schema.String },
) {}

export class HerdrProtocolError extends Schema.TaggedErrorClass<HerdrProtocolError>()(
  "HerdrProtocolError",
  { operation: Schema.String, code: Schema.String, message: Schema.String },
) {}

export class HerdrCommandError extends Schema.TaggedErrorClass<HerdrCommandError>()(
  "HerdrCommandError",
  { operation: Schema.String, code: Schema.String, message: Schema.String },
) {}

export class HerdrConfigError extends Schema.TaggedErrorClass<HerdrConfigError>()(
  "HerdrConfigError",
  { operation: Schema.String, path: Schema.String, message: Schema.String },
) {}

export class HerdrStateError extends Schema.TaggedErrorClass<HerdrStateError>()("HerdrStateError", {
  operation: Schema.String,
  path: Schema.String,
  message: Schema.String,
}) {}

export class HerdrAgentNotFoundError extends Schema.TaggedErrorClass<HerdrAgentNotFoundError>()(
  "HerdrAgentNotFoundError",
  { id: Schema.String, message: Schema.String },
) {}

export class InvalidHerdrRequestError extends Schema.TaggedErrorClass<InvalidHerdrRequestError>()(
  "InvalidHerdrRequestError",
  { code: Schema.String, message: Schema.String },
) {}

export class HerdrOwnershipError extends Schema.TaggedErrorClass<HerdrOwnershipError>()(
  "HerdrOwnershipError",
  { code: Schema.String, message: Schema.String },
) {}

export class HerdrReportError extends Schema.TaggedErrorClass<HerdrReportError>()(
  "HerdrReportError",
  { operation: Schema.String, code: Schema.String, message: Schema.String },
) {}

export class HerdrHarnessError extends Schema.TaggedErrorClass<HerdrHarnessError>()(
  "HerdrHarnessError",
  { operation: Schema.String, code: Schema.String, message: Schema.String },
) {}

export class HerdrRuntimeClosedError extends Schema.TaggedErrorClass<HerdrRuntimeClosedError>()(
  "HerdrRuntimeClosedError",
  { message: Schema.String },
) {}

export type HerdrError =
  | HerdrUnavailableError
  | HerdrProtocolError
  | HerdrCommandError
  | HerdrConfigError
  | HerdrStateError
  | HerdrAgentNotFoundError
  | InvalidHerdrRequestError
  | HerdrOwnershipError
  | HerdrReportError
  | HerdrHarnessError
  | HerdrRuntimeClosedError;
