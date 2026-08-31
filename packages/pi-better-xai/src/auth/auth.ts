import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  decodeJwtPayloadText,
  isJsonObject,
  JsonDocumentStore,
  JsonHttpClient,
  readSchemaDocument,
  type JsonObject,
} from "pi-cosmic-core";
import { ModelRegistryAuth } from "../boundary/model-registry-auth.ts";

export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token";
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;

const PositiveIntegerSchema = Schema.Number.check(
  Schema.isFinite(),
  Schema.isInt(),
  Schema.isGreaterThan(0),
);
const XaiAuthDocumentSchema = Schema.Struct({ xai: Schema.optional(Schema.Unknown) });
const redactedToken = (label: string) =>
  Schema.RedactedFromValue(Schema.Trim.check(Schema.isMinLength(1)), { label });
const XaiAuthEntrySchema = Schema.Struct({
  type: Schema.Literal("oauth"),
  access: redactedToken("xAI access token"),
  refresh: Schema.optional(Schema.NullOr(redactedToken("xAI refresh token"))),
  expires: Schema.optional(Schema.NullOr(PositiveIntegerSchema)),
});

const RefreshResponseSchema = Schema.Struct({
  access_token: redactedToken("xAI access token"),
  refresh_token: Schema.optional(redactedToken("xAI refresh token")),
  expires_in: Schema.optional(PositiveIntegerSchema),
});

const JwtPayloadSchema = Schema.Struct({
  team_id: Schema.optional(Schema.String),
});
const JwtPayloadFromJsonSchema = Schema.fromJsonString(JwtPayloadSchema);
const decodeJwtPayload = Option.liftThrowable(decodeJwtPayloadText);

export interface XaiCredentials {
  readonly accessToken: Redacted.Redacted<string>;
  readonly refreshToken?: Redacted.Redacted<string> | undefined;
  readonly expires?: number | undefined;
  readonly teamId?: string | undefined;
}

type RefreshableXaiCredentials = XaiCredentials & {
  readonly refreshToken: Redacted.Redacted<string>;
};

const hasRefreshToken = (
  credentials: XaiCredentials | null | undefined,
): credentials is RefreshableXaiCredentials => credentials?.refreshToken !== undefined;

export class XaiAuthError extends Schema.TaggedError<XaiAuthError>()("XaiAuthError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export function extractTeamIdFromJwt(token: string): string | undefined {
  const source = Option.getOrUndefined(decodeJwtPayload(token));
  if (!source) return undefined;
  const decoded = Option.getOrUndefined(
    Schema.decodeUnknownOption(JwtPayloadFromJsonSchema)(source),
  );
  return decoded?.team_id?.trim() || undefined;
}

const credentialsFromEntry = Effect.fn("XaiAuth.credentialsFromEntry")(function* <Entry>(
  entry: Entry,
) {
  const decoded = yield* Schema.decodeUnknownEffect(XaiAuthEntrySchema)(entry).pipe(
    Effect.mapError(
      () =>
        new XaiAuthError({ operation: "decode", message: "xAI credential fields are malformed." }),
    ),
  );
  const accessToken = decoded.access;
  const refreshToken = decoded.refresh ?? undefined;
  const expires = decoded.expires ?? undefined;
  const teamId = extractTeamIdFromJwt(Redacted.value(accessToken));
  const credentials: XaiCredentials = { accessToken };
  const withRefreshToken =
    refreshToken === undefined ? credentials : { ...credentials, refreshToken };
  const withExpires = expires === undefined ? withRefreshToken : { ...withRefreshToken, expires };
  return teamId === undefined ? withExpires : { ...withExpires, teamId };
});

export const readXaiCredentials = Effect.fn("XaiAuth.readXaiCredentials")(function* (
  authPath: string,
) {
  const document = yield* readSchemaDocument(authPath, XaiAuthDocumentSchema).pipe(
    Effect.mapError(
      () => new XaiAuthError({ operation: "read", message: "Unable to read xAI credentials." }),
    ),
  );
  const rawEntry = document?.value.xai;
  if (rawEntry === undefined) return undefined;
  return yield* credentialsFromEntry(rawEntry);
});

const equalRedactedTokens = (
  left: Redacted.Redacted<string> | undefined,
  right: Redacted.Redacted<string> | undefined,
): boolean =>
  left === undefined
    ? right === undefined
    : right !== undefined && Redacted.value(left) === Redacted.value(right);

const sameCredentialTuple = (left: XaiCredentials, right: XaiCredentials): boolean =>
  equalRedactedTokens(left.accessToken, right.accessToken) &&
  equalRedactedTokens(left.refreshToken, right.refreshToken) &&
  left.expires === right.expires;

const commitXaiRefresh = Effect.fn("XaiAuth.commitXaiRefresh")(function* (
  authPath: string,
  captured: RefreshableXaiCredentials,
  refreshed: RefreshableXaiCredentials & { readonly expires: number },
) {
  const documents = yield* JsonDocumentStore;
  const modifyObject = documents.modifyObject;
  const writeError = () =>
    new XaiAuthError({ operation: "write", message: "Unable to persist xAI credentials." });
  if (modifyObject === undefined) return yield* writeError();

  return yield* modifyObject(authPath, (document) =>
    Effect.gen(function* () {
      const rawEntry = document.xai;
      if (rawEntry === undefined) return { value: undefined, document, write: false } as const;

      const current = yield* credentialsFromEntry(rawEntry);
      if (!sameCredentialTuple(current, captured))
        return { value: current, document, write: false } as const;

      const previous: JsonObject = isJsonObject(rawEntry) ? rawEntry : {};
      return {
        value: refreshed,
        document: {
          ...document,
          xai: {
            ...previous,
            type: "oauth",
            access: Redacted.value(refreshed.accessToken),
            refresh: Redacted.value(refreshed.refreshToken),
            expires: refreshed.expires,
          },
        } satisfies JsonObject,
      } as const;
    }),
  ).pipe(Effect.catchTag("JsonDocumentError", () => Effect.fail(writeError())));
});

const refreshXaiToken = Effect.fn("XaiAuth.refreshXaiToken")(function* (
  authPath: string,
  captured: RefreshableXaiCredentials,
) {
  const http = yield* JsonHttpClient;
  const refreshTokenValue = Redacted.value(captured.refreshToken);
  const response = yield* http
    .request({
      url: XAI_TOKEN_URL,
      method: "POST",
      headers: { Accept: "application/json" },
      formBody: {
        grant_type: "refresh_token",
        client_id: XAI_OAUTH_CLIENT_ID,
        refresh_token: refreshTokenValue,
      },
      responseSchema: RefreshResponseSchema,
    })
    .pipe(
      Effect.mapError((error) =>
        error.operation === "decode"
          ? new XaiAuthError({
              operation: "refresh-decode",
              message: "xAI OAuth token refresh returned an invalid payload.",
            })
          : new XaiAuthError({
              operation: "refresh",
              message: "xAI OAuth token refresh request failed.",
            }),
      ),
    );
  if (response._tag === "Rejected") {
    return yield* new XaiAuthError({
      operation: "refresh",
      message: `xAI OAuth token refresh failed (HTTP ${response.status}).`,
    });
  }
  const body = response.body;
  const accessToken = body.access_token;
  const nextRefresh = body.refresh_token ?? captured.refreshToken;
  const expiresInSeconds = body.expires_in ?? DEFAULT_TOKEN_LIFETIME_SECONDS;
  const now = yield* Clock.currentTimeMillis;
  const expires = now + expiresInSeconds * 1000;
  const credentials: RefreshableXaiCredentials & { readonly expires: number } = {
    accessToken,
    refreshToken: nextRefresh,
    expires,
  };
  const teamId = extractTeamIdFromJwt(Redacted.value(accessToken));
  const refreshed = teamId === undefined ? credentials : { ...credentials, teamId };
  return yield* commitXaiRefresh(authPath, captured, refreshed);
});

const getModelRegistryXaiCredentials = Effect.fn("XaiAuth.getModelRegistryXaiCredentials")(
  function* () {
    const registryToken = yield* ModelRegistryAuth.use((registry) => registry.getApiKey).pipe(
      Effect.mapError(
        () =>
          new XaiAuthError({ operation: "registry", message: "Unable to read xAI credentials." }),
      ),
    );
    const registryAccess = registryToken?.trim();
    if (!registryAccess) return undefined;
    const teamId = extractTeamIdFromJwt(registryAccess);
    const registryCredentials: XaiCredentials = {
      accessToken: Redacted.make(registryAccess, { label: "xAI access token" }),
    };
    return teamId ? { ...registryCredentials, teamId } : registryCredentials;
  },
);

const hasDifferentAccessToken = (
  credentials: XaiCredentials,
  rejectedAccessToken: Redacted.Redacted<string>,
): boolean => Redacted.value(credentials.accessToken) !== Redacted.value(rejectedAccessToken);

/** Refresh a file-owned credential only when it matches the provider-rejected token. */
export const refreshRejectedXaiCredentials = Effect.fn("XaiAuth.refreshRejectedXaiCredentials")(
  function* (authPath: string, rejectedAccessToken: Redacted.Redacted<string>) {
    const current = yield* readXaiCredentials(authPath).pipe(
      Effect.catchIf(
        (error) => error.operation === "decode",
        () => Effect.succeed(null),
      ),
    );
    if (
      !hasRefreshToken(current) ||
      Redacted.value(current.accessToken) !== Redacted.value(rejectedAccessToken)
    )
      return undefined;
    return yield* refreshXaiToken(authPath, current);
  },
);

/** Resolve at most one replacement for a provider-rejected credential. */
export const recoverRejectedXaiCredentials = Effect.fn("XaiAuth.recoverRejectedXaiCredentials")(
  function* (authPath: string, rejectedAccessToken: Redacted.Redacted<string>) {
    const refreshAttempt = yield* refreshRejectedXaiCredentials(authPath, rejectedAccessToken).pipe(
      Effect.result,
    );
    if (
      refreshAttempt._tag === "Success" &&
      refreshAttempt.success !== undefined &&
      hasDifferentAccessToken(refreshAttempt.success, rejectedAccessToken)
    )
      return refreshAttempt.success;

    // The host registry can change independently of the auth file. Re-resolve it after a failed
    // or unusable file refresh, but never send the credential the provider already rejected.
    const registryAttempt = yield* getModelRegistryXaiCredentials().pipe(Effect.result);
    if (
      registryAttempt._tag === "Success" &&
      registryAttempt.success !== undefined &&
      hasDifferentAccessToken(registryAttempt.success, rejectedAccessToken)
    )
      return registryAttempt.success;

    // Preserve the existing refresh failure when no usable alternate source is available.
    if (refreshAttempt._tag === "Failure") return yield* refreshAttempt.failure;
    return undefined;
  },
);

export const getXaiCredentials = Effect.fn("XaiAuth.getXaiCredentials")(function* (
  authPath: string,
) {
  const now = yield* Clock.currentTimeMillis;
  const fileAttempt = yield* readXaiCredentials(authPath).pipe(Effect.result);
  const auth = fileAttempt._tag === "Success" ? fileAttempt.success : undefined;
  let refreshFailure: XaiAuthError | undefined;

  // Only refresh when expiry is actually known: a schema-legal entry without `expires`
  // is used until the API rejects it instead of forcing a refresh POST on every poll.
  if (
    hasRefreshToken(auth) &&
    auth.expires !== undefined &&
    now >= auth.expires - REFRESH_SKEW_MS
  ) {
    const refreshAttempt = yield* refreshXaiToken(authPath, auth).pipe(Effect.result);
    if (refreshAttempt._tag === "Success") return refreshAttempt.success;
    if (
      refreshAttempt.failure.operation !== "refresh" &&
      refreshAttempt.failure.operation !== "refresh-decode"
    )
      return yield* refreshAttempt.failure;
    refreshFailure = refreshAttempt.failure;
    // A failed provider exchange must not silently flip a still-valid file token over to the
    // model-registry credential source. Commit failures surface because the exchange may already
    // have rotated the captured refresh token.
    if (now < auth.expires) return auth;
  }

  const registryAttempt = yield* getModelRegistryXaiCredentials().pipe(Effect.result);
  if (registryAttempt._tag === "Success" && registryAttempt.success !== undefined)
    return registryAttempt.success;
  if (auth && (auth.expires === undefined || now < auth.expires)) return auth;
  if (refreshFailure !== undefined) return yield* refreshFailure;
  if (fileAttempt._tag === "Failure") return yield* fileAttempt.failure;
  if (registryAttempt._tag === "Failure") return yield* registryAttempt.failure;
  return undefined;
});
