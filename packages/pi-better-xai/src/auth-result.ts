import * as Schema from "effect/Schema";

export const PositiveIntegerSchema = Schema.Number.check(
  Schema.isFinite(),
  Schema.isInt(),
  Schema.isGreaterThan(0),
);

const CredentialsSchema = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.optional(Schema.String),
  expires: Schema.optional(PositiveIntegerSchema),
  teamId: Schema.optional(Schema.String),
  source: Schema.Literals(["modelRegistry", "authFile"]),
});

export const XaiAuthResultSchema = Schema.Union([
  Schema.TaggedStruct("Found", { credentials: CredentialsSchema }),
  Schema.TaggedStruct("Missing", {}),
  Schema.TaggedStruct("Unavailable", {
    operation: Schema.String,
    message: Schema.String,
  }),
  Schema.TaggedStruct("Malformed", {
    operation: Schema.String,
    message: Schema.String,
  }),
]);

export type XaiAuthResult = typeof XaiAuthResultSchema.Type;
