import * as Schema from "effect/Schema";

export type HerdrBtwErrorOutcome = "confirmed" | "uncertain";

export class HerdrBtwError extends Schema.TaggedError<HerdrBtwError>()("HerdrBtwError", {
  operation: Schema.String,
  code: Schema.String,
  message: Schema.String,
  outcome: Schema.Literals(["confirmed", "uncertain"] as const),
  paneId: Schema.optional(Schema.String),
  herdrCode: Schema.optional(Schema.String),
}) {}
