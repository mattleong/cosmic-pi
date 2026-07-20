import * as Schema from "effect/Schema";

const CredentialsSchema = Schema.Struct({
  accessToken: Schema.String,
  accountId: Schema.String,
  source: Schema.Literals(["modelRegistry", "authFile"]),
});

export const CodexAuthResultSchema = Schema.Union([
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

export type CodexAuthResult = typeof CodexAuthResultSchema.Type;
