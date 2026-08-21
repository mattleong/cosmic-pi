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

export const herdrForkError = (
  operation: string,
  code: string,
  message: string,
  outcome: HerdrForkErrorOutcome = "confirmed",
  paneId?: string,
  herdrCode?: string,
): HerdrForkError => {
  const errorBase = { operation, code, message, outcome };
  const errorWithPane = paneId !== undefined ? { ...errorBase, paneId } : errorBase;
  return new HerdrForkError(
    herdrCode !== undefined ? { ...errorWithPane, herdrCode } : errorWithPane,
  );
};
