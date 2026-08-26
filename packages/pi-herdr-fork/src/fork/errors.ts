import * as Schema from "effect/Schema";

export type HerdrForkErrorOutcome = "confirmed" | "uncertain";

export class HerdrForkError extends Schema.TaggedError<HerdrForkError>()("HerdrForkError", {
  operation: Schema.String,
  code: Schema.String,
  message: Schema.String,
  outcome: Schema.Literals(["confirmed", "uncertain"] as const),
  paneId: Schema.optional(Schema.String),
  herdrCode: Schema.optional(Schema.String),
}) {}
