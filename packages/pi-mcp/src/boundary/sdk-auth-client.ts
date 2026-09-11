import type { OAuthClientInformationMixed } from "@modelcontextprotocol/client";
import {
  OAuthClientInformationFullSchema,
  OAuthClientInformationSchema,
} from "@modelcontextprotocol/core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { deniedAuth } from "../auth/policy.ts";
import { boundaryError } from "../client/errors.ts";

/** Never let an unused registration secret select SDK client authentication or enter storage. */
export const normalizePublicClient = (client: OAuthClientInformationMixed) =>
  Effect.gen(function* () {
    const method =
      "token_endpoint_auth_method" in client ? client.token_endpoint_auth_method : undefined;
    if (method !== undefined && method !== "none")
      return yield* boundaryError(
        "unsupported",
        "not-sent",
        "OAuth registration selected an unsupported client authentication method.",
        "oauth-client-auth-method-unsupported",
      );
    if (client.client_secret !== undefined && method !== "none")
      return yield* boundaryError(
        "unsupported",
        "not-sent",
        "OAuth registration returned a secret without explicitly selecting public-client authentication.",
        "oauth-client-auth-method-ambiguous",
      );
    const normalized = { ...client, token_endpoint_auth_method: "none" as const };
    delete normalized.client_secret;
    delete normalized.client_secret_expires_at;
    return normalized;
  });

// The SDK's information-only decoder drops registration metadata, including this policy field.
const storedMethod = Schema.Struct({
  token_endpoint_auth_method: Schema.optionalKey(Schema.String),
  redirect_uris: Schema.optionalKey(Schema.Array(Schema.String)),
});
export const restorePublicClient = (raw: Schema.Json) =>
  Effect.gen(function* () {
    const method = yield* Schema.decodeUnknownEffect(storedMethod)(raw).pipe(
      Effect.mapError(deniedAuth),
    );
    const information = yield* Effect.try({
      try: () =>
        method.redirect_uris === undefined
          ? OAuthClientInformationSchema.parse(raw)
          : OAuthClientInformationFullSchema.parse(raw),
      catch: deniedAuth,
    });
    return yield* normalizePublicClient({ ...information, ...method });
  });
