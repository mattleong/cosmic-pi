import * as Schema from "effect/Schema";

export class HerdrBtwError extends Schema.TaggedError<HerdrBtwError>()("HerdrBtwError", {
  operation: Schema.String,
  code: Schema.String,
  message: Schema.String,
  outcome: Schema.Literals(["confirmed", "uncertain"] as const),
  paneId: Schema.optional(Schema.String),
}) {}

export const confirmedFailure = (operation: string, code: string, message: string): HerdrBtwError =>
  new HerdrBtwError({ operation, code, message, outcome: "confirmed" });

export const uncertainFailure = (operation: string, code: string, message: string): HerdrBtwError =>
  new HerdrBtwError({ operation, code, message, outcome: "uncertain" });
