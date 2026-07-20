import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { JsonDocumentStore, JsonHttpClient, type JsonObject } from "pi-cosmic-core";
import { isRecord } from "./utils.ts";

export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token";
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;

const XaiAuthEntrySchema = Schema.Struct({
  type: Schema.Literal("oauth"),
  access: Schema.String,
  refresh: Schema.optional(Schema.NullOr(Schema.String)),
  expires: Schema.optional(Schema.NullOr(Schema.Number)),
});

const RefreshResponseSchema = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
});

const JwtPayloadSchema = Schema.Struct({
  team_id: Schema.optional(Schema.String),
});

export class XaiAuthError extends Schema.TaggedErrorClass<XaiAuthError>()("XaiAuthError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export interface XaiCredentials {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expires?: number;
  readonly teamId?: string;
}

export interface XaiCredentialsWithSource extends XaiCredentials {
  readonly source: "modelRegistry" | "authFile";
}

const decodeBase64Url = (value: string) =>
  Effect.try({
    try: () => {
      const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
      const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
      return Buffer.from(padded, "base64").toString("utf8");
    },
    catch: () =>
      new XaiAuthError({ operation: "jwt", message: "Unable to decode xAI token metadata." }),
  });

export const extractTeamIdFromJwt = Effect.fn("XaiAuth.extractTeamIdFromJwt")(function* (
  token: string,
) {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  const source = yield* decodeBase64Url(payload).pipe(Effect.catch(() => Effect.succeed("")));
  if (!source) return undefined;
  const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(JwtPayloadSchema))(
    source,
  ).pipe(Effect.catch(() => Effect.void));
  const teamId = decoded?.team_id?.trim();
  return teamId || undefined;
});

const credentialsFromEntry = Effect.fn("XaiAuth.credentialsFromEntry")(function* (entry: unknown) {
  const decoded = yield* Schema.decodeUnknownEffect(XaiAuthEntrySchema)(entry).pipe(
    Effect.catch(() => Effect.void),
  );
  if (!decoded) return undefined;
  const accessToken = decoded.access.trim();
  if (!accessToken) return undefined;
  const refreshToken = decoded.refresh?.trim() || undefined;
  const teamId = yield* extractTeamIdFromJwt(accessToken);
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(typeof decoded.expires === "number" ? { expires: decoded.expires } : {}),
    ...(teamId ? { teamId } : {}),
  } satisfies XaiCredentials;
});

export const readXaiAuth = Effect.fn("XaiAuth.readXaiAuth")(function* (authPath: string) {
  const documents = yield* JsonDocumentStore;
  const document = yield* documents.readObject(authPath).pipe(
    Effect.mapError(
      () => new XaiAuthError({ operation: "read", message: "Unable to read xAI credentials." }),
    ),
    Effect.catch(() => Effect.void),
  );
  return yield* credentialsFromEntry(document?.xai);
});

const writeXaiAuth = Effect.fn("XaiAuth.writeXaiAuth")(function* (
  authPath: string,
  entry: { readonly access: string; readonly refresh: string; readonly expires: number },
) {
  const documents = yield* JsonDocumentStore;
  yield* documents
    .updateObject(authPath, (document) => {
      const previous = isRecord(document.xai) ? document.xai : {};
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
  refreshToken: string,
) {
  const http = yield* JsonHttpClient;
  const response = yield* http
    .request({
      url: XAI_TOKEN_URL,
      method: "POST",
      headers: { Accept: "application/json" },
      formBody: {
        grant_type: "refresh_token",
        client_id: XAI_OAUTH_CLIENT_ID,
        refresh_token: refreshToken,
      },
    })
    .pipe(
      Effect.mapError(
        () =>
          new XaiAuthError({
            operation: "refresh",
            message: "xAI OAuth token refresh request failed.",
          }),
      ),
    );
  if (response.status < 200 || response.status >= 300) {
    return yield* new XaiAuthError({
      operation: "refresh",
      message: `xAI OAuth token refresh failed (HTTP ${response.status}).`,
    });
  }
  const body = yield* Schema.decodeUnknownEffect(RefreshResponseSchema)(response.body).pipe(
    Effect.mapError(
      () =>
        new XaiAuthError({
          operation: "refresh-decode",
          message: "xAI OAuth token refresh returned an invalid payload.",
        }),
    ),
  );
  const accessToken = body.access_token.trim();
  if (!accessToken) {
    return yield* new XaiAuthError({
      operation: "refresh-decode",
      message: "xAI OAuth token refresh returned an invalid payload.",
    });
  }
  const nextRefresh = body.refresh_token?.trim() || refreshToken;
  const expiresInSeconds =
    typeof body.expires_in === "number" && Number.isFinite(body.expires_in) && body.expires_in > 0
      ? body.expires_in
      : DEFAULT_TOKEN_LIFETIME_SECONDS;
  const now = yield* Clock.currentTimeMillis;
  const expires = now + expiresInSeconds * 1000;
  yield* writeXaiAuth(authPath, { access: accessToken, refresh: nextRefresh, expires });
  const teamId = yield* extractTeamIdFromJwt(accessToken);
  return {
    accessToken,
    refreshToken: nextRefresh,
    expires,
    ...(teamId ? { teamId } : {}),
  } satisfies XaiCredentials;
});

export const getXaiCredentials = Effect.fn("XaiAuth.getXaiCredentials")(function* (
  authPath: string,
  ctx: Pick<ExtensionContext, "modelRegistry">,
) {
  const now = yield* Clock.currentTimeMillis;
  const auth = yield* readXaiAuth(authPath);
  if (auth?.refreshToken && (auth.expires === undefined || now >= auth.expires - REFRESH_SKEW_MS)) {
    const refreshed = yield* refreshXaiToken(authPath, auth.refreshToken).pipe(
      Effect.map((credentials) => ({ ...credentials, source: "authFile" as const })),
      Effect.catch(() => Effect.void),
    );
    if (refreshed) return refreshed;
  }

  const registryToken = yield* Effect.tryPromise({
    try: () => ctx.modelRegistry.getApiKeyForProvider("xai"),
    catch: () =>
      new XaiAuthError({ operation: "registry", message: "Unable to read xAI credentials." }),
  }).pipe(Effect.catch(() => Effect.void));
  const registryAccess = registryToken?.trim();
  if (registryAccess) {
    const teamId = yield* extractTeamIdFromJwt(registryAccess);
    return {
      accessToken: registryAccess,
      source: "modelRegistry" as const,
      ...(teamId ? { teamId } : {}),
    } satisfies XaiCredentialsWithSource;
  }

  if (auth?.accessToken && (auth.expires === undefined || now < auth.expires)) {
    return { ...auth, source: "authFile" as const } satisfies XaiCredentialsWithSource;
  }
  return undefined;
});
