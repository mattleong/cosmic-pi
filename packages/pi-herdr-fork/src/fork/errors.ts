import * as Schema from "effect/Schema";

export type HerdrForkErrorOutcome = "confirmed" | "uncertain";

export class HerdrForkError extends Schema.TaggedErrorClass<HerdrForkError>()("HerdrForkError", {
  operation: Schema.String,
  code: Schema.String,
  message: Schema.String,
  outcome: Schema.Literals(["confirmed", "uncertain"] as const),
  paneId: Schema.optional(Schema.String),
  herdrCode: Schema.optional(Schema.String),
}) {}

export const herdrForkError = (
  operation: string,
  code: string,
  message: string,
  outcome: HerdrForkErrorOutcome = "confirmed",
  paneId?: string,
  herdrCode?: string,
): HerdrForkError =>
  new HerdrForkError({
    operation,
    code,
    message,
    outcome,
    ...(paneId === undefined ? {} : { paneId }),
    ...(herdrCode === undefined ? {} : { herdrCode }),
  });
