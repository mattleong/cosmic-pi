import * as Predicate from "effect/Predicate";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
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
import {
  PositiveIntegerSchema,
  type XaiAuthResult,
  type XaiAuthResultCredentials,
} from "./result.ts";
import { ModelRegistryAuth } from "../boundary/model-registry-auth.ts";

export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token";
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;

const XaiAuthDocumentSchema = Schema.Struct({ xai: Schema.optional(Schema.Unknown) });
const XaiAuthEntrySchema = Schema.Struct({
  type: Schema.Literal("oauth"),
  access: Schema.String,
  refresh: Schema.optional(Schema.NullOr(Schema.String)),
  expires: Schema.optional(Schema.NullOr(PositiveIntegerSchema)),
});

const RefreshResponseSchema = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(PositiveIntegerSchema),
});

const JwtPayloadSchema = Schema.Struct({
  team_id: Schema.optional(Schema.String),
});

export class XaiAuthError extends Schema.TaggedError<XaiAuthError>()("XaiAuthError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export interface XaiCredentials {
  readonly accessToken: Redacted.Redacted<string>;
  readonly refreshToken?: Redacted.Redacted<string>;
  readonly expires?: number;
  readonly teamId?: string;
}

export const extractTeamIdFromJwt = Effect.fn("XaiAuth.extractTeamIdFromJwt")(function* (
  token: string,
) {
  const source = yield* Effect.try({
    try: () => decodeJwtPayloadText(token),
    catch: () =>
      new XaiAuthError({ operation: "jwt", message: "Unable to decode xAI token metadata." }),
  }).pipe(Effect.catch(() => Effect.succeed("")));
  if (!source) return undefined;
  const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(JwtPayloadSchema))(
    source,
  ).pipe(Effect.catch(() => Effect.void));
  const teamId = decoded?.team_id?.trim();
  return teamId || undefined;
});

const credentialsFromEntry = Effect.fn("XaiAuth.credentialsFromEntry")(function* <Entry>(
  entry: Entry,
) {
  const decoded = yield* Schema.decodeUnknownEffect(XaiAuthEntrySchema)(entry).pipe(
    Effect.mapError(
      () =>
        new XaiAuthError({ operation: "decode", message: "xAI credential fields are malformed." }),
    ),
  );
  const accessToken = decoded.access.trim();
  if (!accessToken)
    return yield* new XaiAuthError({
      operation: "decode",
      message: "xAI credential fields are malformed.",
    });
  const refreshToken = decoded.refresh?.trim() || undefined;
  const teamId = yield* extractTeamIdFromJwt(accessToken);
  const baseCredentials: XaiCredentials = {
    accessToken: Redacted.make(accessToken, { label: "xAI access token" }),
  };
  const withRefreshToken: XaiCredentials = refreshToken
    ? {
        ...baseCredentials,
        refreshToken: Redacted.make(refreshToken, { label: "xAI refresh token" }),
      }
    : baseCredentials;
  const withExpires: XaiCredentials = Predicate.isNumber(decoded.expires)
    ? { ...withRefreshToken, expires: decoded.expires }
    : withRefreshToken;
  const credentials: XaiCredentials = teamId ? { ...withExpires, teamId } : withExpires;
  return credentials;
});

export const readXaiAuthResult = Effect.fn("XaiAuth.readXaiAuthResult")(function* (
  authPath: string,
) {
  const document = yield* readSchemaDocument(authPath, XaiAuthDocumentSchema).pipe(
    Effect.mapError(
      () => new XaiAuthError({ operation: "read", message: "Unable to read xAI credentials." }),
    ),
  );
  const rawEntry = document?.value.xai;
  if (rawEntry === undefined) return { _tag: "Missing" } as const;
  const decoded = yield* credentialsFromEntry(rawEntry).pipe(Effect.result);
  if (decoded._tag === "Failure")
    return {
      _tag: "Malformed",
      operation: decoded.failure.operation,
      message: decoded.failure.message,
    } as const satisfies XaiAuthResult;
  return {
    _tag: "Found",
    credentials: { ...decoded.success, source: "authFile" as const },
  } as const satisfies XaiAuthResult;
});

const writeXaiAuth = Effect.fn("XaiAuth.writeXaiAuth")(function* (
  authPath: string,
  entry: { readonly access: string; readonly refresh: string; readonly expires: number },
) {
  const documents = yield* JsonDocumentStore;
  yield* documents
    .updateObject(authPath, (document) => {
      const previous: JsonObject = isJsonObject(document.xai) ? document.xai : {};
      return {
        ...document,
        xai: {
          ...previous,
          type: "oauth",
          access: entry.access,
          refresh: entry.refresh,
          expires: entry.expires,
        },
      } satisfies JsonObject;
    })
    .pipe(
      Effect.mapError(
        () =>
          new XaiAuthError({ operation: "write", message: "Unable to persist xAI credentials." }),
      ),
    );
});

const refreshXaiToken = Effect.fn("XaiAuth.refreshXaiToken")(function* (
  authPath: string,
  refreshToken: Redacted.Redacted<string>,
) {
  const http = yield* JsonHttpClient;
  const refreshTokenValue = Redacted.value(refreshToken);
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
  const accessToken = body.access_token.trim();
  if (!accessToken) {
    return yield* new XaiAuthError({
      operation: "refresh-decode",
      message: "xAI OAuth token refresh returned an invalid payload.",
    });
  }
  const nextRefresh = body.refresh_token?.trim() || refreshTokenValue;
  const expiresInSeconds = body.expires_in ?? DEFAULT_TOKEN_LIFETIME_SECONDS;
  const now = yield* Clock.currentTimeMillis;
  const expires = now + expiresInSeconds * 1000;
  yield* writeXaiAuth(authPath, { access: accessToken, refresh: nextRefresh, expires });
  const teamId = yield* extractTeamIdFromJwt(accessToken);
  const credentialsBase: XaiCredentials = {
    accessToken: Redacted.make(accessToken, { label: "xAI access token" }),
    refreshToken: Redacted.make(nextRefresh, { label: "xAI refresh token" }),
    expires,
  };
  const credentials: XaiCredentials = teamId ? { ...credentialsBase, teamId } : credentialsBase;
  return credentials;
});

export const getXaiCredentialsResult = Effect.fn("XaiAuth.getXaiCredentialsResult")(function* (
  authPath: string,
) {
  const now = yield* Clock.currentTimeMillis;
  const fileResult = yield* readXaiAuthResult(authPath).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        _tag: "Unavailable",
        operation: error.operation,
        message: error.message,
      } as const),
    ),
  );
  const auth = fileResult._tag === "Found" ? fileResult.credentials : undefined;
  let refreshFailure: XaiAuthError | undefined;
  // Only refresh when expiry is actually known: a schema-legal entry without `expires`
  // is used until the API rejects it instead of forcing a refresh POST on every poll.
  if (
    auth?.refreshToken !== undefined &&
    auth.expires !== undefined &&
    now >= auth.expires - REFRESH_SKEW_MS
  ) {
    const refreshed = yield* refreshXaiToken(authPath, auth.refreshToken).pipe(Effect.result);
    if (refreshed._tag === "Success")
      return {
        _tag: "Found",
        credentials: { ...refreshed.success, source: "authFile" as const },
      } as const;
    refreshFailure = refreshed.failure;
    // A failed refresh must not silently flip a still-valid file token over to the
    // model-registry credential source; keep using it until it actually expires.
    if (auth.accessToken && now < auth.expires)
      return { _tag: "Found", credentials: auth } as const;
  }

  const registryToken = yield* ModelRegistryAuth.use((registry) => registry.getApiKey).pipe(
    Effect.mapError(
      () => new XaiAuthError({ operation: "registry", message: "Unable to read xAI credentials." }),
    ),
    Effect.result,
  );
  if (registryToken._tag === "Success") {
    const registryAccess = registryToken.success?.trim();
    if (registryAccess) {
      const teamId = yield* extractTeamIdFromJwt(registryAccess);
      const registryCredentials: XaiAuthResultCredentials = {
        accessToken: Redacted.make(registryAccess, { label: "xAI access token" }),
        source: "modelRegistry" as const,
      };
      const credentials: XaiAuthResultCredentials = teamId
        ? { ...registryCredentials, teamId }
        : registryCredentials;
      return { _tag: "Found", credentials } as const satisfies XaiAuthResult;
    }
  }
  if (auth?.accessToken && (auth.expires === undefined || now < auth.expires))
    return { _tag: "Found", credentials: auth } as const;
  if (refreshFailure)
    return {
      _tag: "Unavailable",
      operation: refreshFailure.operation,
      message: refreshFailure.message,
    } as const;
  if (fileResult._tag === "Malformed" || fileResult._tag === "Unavailable") return fileResult;
  if (registryToken._tag === "Failure")
    return {
      _tag: "Unavailable",
      operation: registryToken.failure.operation,
      message: registryToken.failure.message,
    } as const;
  return { _tag: "Missing" } as const;
});

export const getXaiCredentials = Effect.fn("XaiAuth.getXaiCredentials")(function* (
  authPath: string,
) {
  const result = yield* getXaiCredentialsResult(authPath);
  if (result._tag === "Found") return result.credentials;
  if (result._tag === "Missing") return undefined;
  return yield* new XaiAuthError({ operation: result.operation, message: result.message });
});
