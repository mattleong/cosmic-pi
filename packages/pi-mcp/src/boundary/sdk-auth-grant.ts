import {
  checkResourceAllowed,
  type AuthorizationServerMetadata,
  type OAuthClientInformationMixed,
  type OAuthProtectedResourceMetadata,
  type OAuthTokens,
} from "@modelcontextprotocol/client";
import {
  OAuthMetadataSchema,
  OAuthProtectedResourceMetadataSchema,
  OAuthTokensSchema,
} from "@modelcontextprotocol/core";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { hasControlCharacter } from "pi-cosmic-core";
import type { McpGrant } from "../auth/credentials.ts";
import {
  deniedAuth,
  oauthConfig,
  authUrlPolicy,
  resourceMetadataFallback,
  validateAuthUrl,
  callbackRedirect,
} from "../auth/policy.ts";
import { parseScopes, validateScopes } from "../auth/scopes.ts";
import { boundaryError } from "../client/errors.ts";
import type { McpEffectiveServer, McpOAuthConfig } from "../config/model.ts";
import { restorePublicClient } from "./sdk-auth-client.ts";

export const sdkAuthValue = <A>(work: () => A) => Effect.try({ try: work, catch: deniedAuth });

/**
 * RFC 9728 servers often publish their origin or a parent path as the resource. Like the
 * SDK, an endpoint accepts a same-origin path prefix and binds to the published
 * identifier. A configured resource must match exactly, and a published query must
 * match the expected one.
 */
export const resourceAllowed = (config: McpOAuthConfig, expected: URL, published: URL) =>
  config.resource !== undefined
    ? published.href === expected.href
    : (published.search === "" || published.search === expected.search) &&
      checkResourceAllowed({ requestedResource: expected, configuredResource: published });
export const authJson = (
  value:
    | AuthorizationServerMetadata
    | OAuthClientInformationMixed
    | OAuthProtectedResourceMetadata
    | OAuthTokens,
) =>
  Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(value).pipe(
    Effect.flatMap((text) => Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(text)),
    Effect.mapError(deniedAuth),
  );
const validTokens = (tokens: OAuthTokens): boolean =>
  tokens.token_type.toLowerCase() === "bearer" &&
  tokens.access_token.length > 0 &&
  !hasControlCharacter(tokens.access_token) &&
  !/\s/.test(tokens.access_token) &&
  (tokens.expires_in === undefined ||
    (Number.isFinite(tokens.expires_in) && tokens.expires_in >= 0));
/** RFC 6749 section 3.3 lets the server grant different scopes; only their syntax is checked. */
const tokenScopes = (tokens: OAuthTokens, requested?: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (requested) yield* validateScopes(requested);
    if (tokens.scope !== undefined) yield* parseScopes(tokens.scope);
  });

/** No stored quarantined token may escape this boundary, including through refresh. */
export const decodeSdkGrant = (server: McpEffectiveServer, grant: McpGrant) =>
  Effect.gen(function* () {
    if (grant.quarantine)
      return yield* boundaryError(
        "auth-required",
        "not-sent",
        "OAuth refresh requires a new sign-in.",
        "oauth-refresh-unresolved",
      );
    const config = oauthConfig(server);
    if (
      !config ||
      server.definition?.transport !== "http" ||
      grant.identity !== server.credentialIdentity ||
      (grant.registration !== config.registration &&
        !(grant.registration === "dynamic" && config.dynamicFallback === true)) ||
      (grant.resourceMetadataSource === "configured" &&
        (config.allowMissingResourceMetadata === false || config.issuer === undefined)) ||
      (config.issuer !== undefined && grant.issuer !== config.issuer) ||
      (config.registration === "pre-registered" && grant.clientId !== config.clientId)
    )
      return yield* deniedAuth();
    if (grant.resourceMetadataSource === "origin") {
      const fallback = yield* resourceMetadataFallback(server.definition.url, config);
      if (
        fallback?.source !== "origin" ||
        (fallback.issuer !== grant.issuer && `${fallback.issuer}/` !== grant.issuer)
      )
        return yield* deniedAuth();
    }
    const policy = yield* authUrlPolicy(server);
    const expectedResource = yield* validateAuthUrl(
      config.resource ?? server.definition.url,
      policy,
    );
    const storedResource = yield* validateAuthUrl(grant.resource, policy);
    if (!resourceAllowed(config, expectedResource, storedResource)) return yield* deniedAuth();
    if (grant.registration === "metadata") {
      if (!config.clientMetadataUrl) return yield* deniedAuth();
      const expectedClient = yield* validateAuthUrl(config.clientMetadataUrl, policy);
      if (grant.clientId !== expectedClient.href) return yield* deniedAuth();
    }
    const metadata = yield* sdkAuthValue(() => OAuthMetadataSchema.parse(grant.discovery));
    const rawResource = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ resource: Schema.String }),
    )(grant.resourceMetadata).pipe(Effect.mapError(deniedAuth));
    const metadataResource = yield* validateAuthUrl(rawResource.resource, policy);
    const resource = yield* sdkAuthValue(() =>
      OAuthProtectedResourceMetadataSchema.parse(grant.resourceMetadata),
    );
    const client = yield* restorePublicClient(grant.clientInformation);
    const tokens = yield* sdkAuthValue(() => OAuthTokensSchema.parse(grant.tokens));
    const expiresAt =
      tokens.expires_in === undefined ? undefined : grant.receivedAt + tokens.expires_in * 1000;
    if (
      metadata.issuer !== grant.issuer ||
      metadataResource.href !== storedResource.href ||
      !resource.authorization_servers?.includes(grant.issuer) ||
      client.client_id !== grant.clientId ||
      !validTokens(tokens) ||
      expiresAt !== grant.expiresAt
    )
      return yield* deniedAuth();
    yield* tokenScopes(tokens, grant.requestedScopes);
    const issuerUrl = yield* validateAuthUrl(grant.issuer, policy);
    if (issuerUrl.search) return yield* deniedAuth();
    yield* validateAuthUrl(metadata.token_endpoint, policy);
    yield* validateAuthUrl(metadata.authorization_endpoint, policy);
    yield* callbackRedirect(grant.redirectUri);
    return { metadata, client, tokens };
  });

export const sdkGrantReceipt = (
  grant: Omit<McpGrant, "tokens" | "receivedAt" | "expiresAt">,
  tokens: OAuthTokens,
) =>
  Effect.gen(function* () {
    if (!validTokens(tokens)) return yield* deniedAuth();
    yield* tokenScopes(tokens, grant.requestedScopes);
    const receivedAt = yield* Clock.currentTimeMillis;
    const expiresAt =
      tokens.expires_in === undefined ? undefined : receivedAt + tokens.expires_in * 1000;
    if (expiresAt !== undefined && !Number.isFinite(expiresAt)) return yield* deniedAuth();
    return { ...grant, tokens: yield* authJson(tokens), receivedAt, expiresAt } satisfies McpGrant;
  });
