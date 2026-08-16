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
): HerdrForkError =>
  new HerdrForkError(
    (() => {
      const objectPart654_0 = { operation, code, message, outcome };
      const objectPart654_1 =
        paneId === undefined ? objectPart654_0 : { ...objectPart654_0, paneId };
      const objectPart654_2 =
        herdrCode === undefined ? objectPart654_1 : { ...objectPart654_1, herdrCode };
      return objectPart654_2;
    })(),
  );
