import * as Schema from "effect/Schema";

const CredentialsSchema = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.optional(Schema.String),
  expires: Schema.optional(Schema.Number),
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
