import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { decodeUnknownOrUndefined, extractJwtClaim, redactedTokenSchema } from "pi-cosmic-core";

const redactedAccessToken = redactedTokenSchema("OpenAI Codex access token");
const RegistryCredentialsFromJsonSchema = Schema.fromJsonString(
  Schema.Struct({
    access: Schema.optional(redactedAccessToken),
    token: Schema.optional(redactedAccessToken),
    accountId: Schema.optional(Schema.String),
    account_id: Schema.optional(Schema.String),
  }),
);
const JwtPayloadFromJsonSchema = Schema.fromJsonString(
  Schema.Struct({
    "https://api.openai.com/auth": Schema.optional(
      Schema.Struct({ chatgpt_account_id: Schema.optional(Schema.String) }),
    ),
  }),
);

export class CodexAuthError extends Schema.TaggedError<
  CodexAuthError,
  { readonly brand: unique symbol }
>()("CodexAuthError", {
  operation: Schema.Literals(["registry", "registry-decode"]),
  message: Schema.String,
}) {}
export type CodexCredentials = {
  readonly accessToken: Redacted.Redacted;
  readonly accountId: string;
};

const decodeRegistryCredentials = decodeUnknownOrUndefined(RegistryCredentialsFromJsonSchema);

const parseRegistryCredentials = (value: string): CodexCredentials | undefined => {
  const parsed = decodeRegistryCredentials(value);
  const parsedToken = parsed?.access ?? parsed?.token;
  const parsedAccountId = (parsed?.accountId ?? parsed?.account_id)?.trim();
  if (parsedToken && parsedAccountId)
    return { accessToken: parsedToken, accountId: parsedAccountId };
  const claims = extractJwtClaim(value, JwtPayloadFromJsonSchema);
  const accountId = claims?.["https://api.openai.com/auth"]?.chatgpt_account_id?.trim();
  if (!accountId) return undefined;
  return { accessToken: Redacted.make(value, { label: "OpenAI Codex access token" }), accountId };
};

export const getCodexCredentials = Effect.fn("CodexAuth.getCredentials")(function* (
  ctx: Pick<ExtensionContext, "modelRegistry">,
) {
  const apiKey = yield* Effect.tryPromise({
    try: () =>
      ctx.modelRegistry.getProviderAuth("openai-codex").then((result) => result?.auth.apiKey),
    catch: () =>
      new CodexAuthError({
        operation: "registry",
        message: "Unable to read openai-codex credentials.",
      }),
  });
  if (!apiKey) return undefined;
  const credentials = parseRegistryCredentials(apiKey.trim());
  if (credentials) return credentials;
  return yield* new CodexAuthError({
    operation: "registry-decode",
    message: "OpenAI registry credentials are malformed.",
  });
});
