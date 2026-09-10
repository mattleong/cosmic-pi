import {
  discoverAuthorizationServerMetadata,
  startAuthorization,
  registerClient,
  exchangeAuthorization,
  refreshAuthorization,
  validateAuthorizationResponseIssuer,
  validateClientMetadataUrl,
  type AuthorizationServerMetadata,
  type OAuthClientInformationMixed,
  type OAuthProtectedResourceMetadata,
  type OAuthTokens,
} from "@modelcontextprotocol/client";
import {
  OAuthClientInformationSchema,
  OAuthClientInformationFullSchema,
  OAuthMetadataSchema,
  OAuthProtectedResourceMetadataSchema,
  OAuthTokensSchema,
} from "@modelcontextprotocol/core";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { hasControlCharacter, NetworkAddresses } from "pi-cosmic-core";
import type { McpLoginUi } from "../auth/model.ts";
import { authProgress } from "../auth/progress.ts";
import type { McpGrant } from "../auth/credentials.ts";
import {
  authFailure,
  authUrlPolicy,
  callbackRedirect,
  deniedAuth,
  oauthConfig,
  singleUseCallback,
  validateAuthAddresses,
  validateAuthUrl,
} from "../auth/policy.ts";
import { boundaryError, type McpBoundaryError } from "../client/errors.ts";
import type { McpEffectiveServer } from "../config/model.ts";
import { openAuthCallback } from "./auth-callback.ts";
import { withAuthFetch } from "./auth-fetch.ts";
import { discoverAuthResource } from "./sdk-auth-discovery.ts";

const unsupported = () =>
  boundaryError(
    "unsupported",
    "not-sent",
    "OAuth requires an advertised public-client registration and PKCE flow.",
    "oauth-registration-unsupported",
  );
const sdk = <A>(work: () => A) => Effect.try({ try: work, catch: deniedAuth });
const json = (
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
const publicClient = (client: OAuthClientInformationMixed): boolean =>
  client.client_secret === undefined &&
  (!("token_endpoint_auth_method" in client) ||
    client.token_endpoint_auth_method === "none" ||
    client.token_endpoint_auth_method === undefined);
const validTokens = (tokens: OAuthTokens): boolean =>
  tokens.token_type.toLowerCase() === "bearer" &&
  tokens.access_token.length > 0 &&
  !hasControlCharacter(tokens.access_token) &&
  !/\s/.test(tokens.access_token) &&
  (tokens.expires_in === undefined ||
    (Number.isFinite(tokens.expires_in) && tokens.expires_in >= 0));

export interface McpSdkAuthContract {
  readonly login: (
    server: McpEffectiveServer,
    ui: McpLoginUi,
  ) => Effect.Effect<McpGrant, McpBoundaryError>;
  readonly refresh: (
    server: McpEffectiveServer,
    grant: McpGrant,
  ) => Effect.Effect<McpGrant, McpBoundaryError>;
  readonly token: (
    server: McpEffectiveServer,
    grant: McpGrant,
  ) => Effect.Effect<string, McpBoundaryError>;
}
export const makeMcpSdkAuth = Effect.gen(function* () {
  const network = yield* NetworkAddresses;
  const crypto = yield* Crypto.Crypto;
  const decode = (server: McpEffectiveServer, grant: McpGrant) =>
    Effect.gen(function* () {
      const config = oauthConfig(server);
      if (
        !config ||
        server.definition?.transport !== "http" ||
        grant.identity !== server.identity ||
        grant.registration !== config.registration ||
        (grant.resourceMetadataSource === "configured" &&
          (config.allowMissingResourceMetadata !== true || config.issuer === undefined)) ||
        (config.issuer !== undefined && grant.issuer !== config.issuer) ||
        (config.registration === "pre-registered" && grant.clientId !== config.clientId)
      )
        return yield* deniedAuth();
      const policy = yield* authUrlPolicy(server);
      const expectedResource = yield* validateAuthUrl(
        config.resource ?? server.definition.url,
        policy,
      );
      if (grant.resource !== expectedResource.href) return yield* deniedAuth();
      if (config.registration === "metadata") {
        if (!config.clientMetadataUrl) return yield* deniedAuth();
        const expectedClient = yield* validateAuthUrl(config.clientMetadataUrl, policy);
        if (grant.clientId !== expectedClient.href) return yield* deniedAuth();
      }
      const metadata = yield* sdk(() => OAuthMetadataSchema.parse(grant.discovery));
      const resource = yield* sdk(() =>
        OAuthProtectedResourceMetadataSchema.parse(grant.resourceMetadata),
      );
      const client = yield* sdk(() => OAuthClientInformationSchema.parse(grant.clientInformation));
      const tokens = yield* sdk(() => OAuthTokensSchema.parse(grant.tokens));
      const expiresAt =
        tokens.expires_in === undefined ? undefined : grant.receivedAt + tokens.expires_in * 1000;
      if (
        metadata.issuer !== grant.issuer ||
        resource.resource !== grant.resource ||
        !resource.authorization_servers?.includes(grant.issuer) ||
        client.client_id !== grant.clientId ||
        !publicClient(client) ||
        !validTokens(tokens) ||
        expiresAt !== grant.expiresAt
      )
        return yield* deniedAuth();
      const issuerUrl = yield* validateAuthUrl(grant.issuer, policy);
      if (issuerUrl.search) return yield* deniedAuth();
      yield* validateAuthUrl(metadata.token_endpoint, policy);
      yield* validateAuthUrl(metadata.authorization_endpoint, policy);
      yield* callbackRedirect(grant.redirectUri);
      return { metadata, client: { ...client, token_endpoint_auth_method: "none" }, tokens };
    });
  const receipt = (
    grant: Omit<McpGrant, "tokens" | "receivedAt" | "expiresAt">,
    tokens: OAuthTokens,
  ) =>
    Effect.gen(function* () {
      if (!validTokens(tokens)) return yield* deniedAuth();
      const receivedAt = yield* Clock.currentTimeMillis;
      const expiresAt =
        tokens.expires_in === undefined ? undefined : receivedAt + tokens.expires_in * 1000;
      if (expiresAt !== undefined && !Number.isFinite(expiresAt)) return yield* deniedAuth();
      return { ...grant, tokens: yield* json(tokens), receivedAt, expiresAt } satisfies McpGrant;
    });
  const login: McpSdkAuthContract["login"] = (server, ui) =>
    Effect.gen(function* () {
      const deadline = (yield* Clock.currentTimeMillis) + 180_000;
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const config = oauthConfig(server);
          if (!config || server.definition?.transport !== "http") return yield* authFailure();
          const policy = yield* authUrlPolicy(server);
          if (ui.mode === "local")
            yield* authProgress(ui, { phase: "callback-listener", deadline });
          const listener =
            ui.mode === "local" ? yield* openAuthCallback(config.redirectUri) : undefined;
          const redirect =
            listener?.redirectUri ?? (yield* callbackRedirect(config.redirectUri)).href;
          if (ui.mode === "manual" && (!config.redirectUri || new URL(redirect).port === "0"))
            return yield* unsupported();
          const resourceUrl = yield* validateAuthUrl(
            config.resource ?? server.definition.url,
            policy,
          );
          const endpoint = server.definition.url;
          yield* authProgress(ui, { phase: "discovery", deadline });
          const discovery = yield* discoverAuthResource(endpoint, resourceUrl, config, policy).pipe(
            Effect.provideService(NetworkAddresses, network),
          );
          const resource = discovery.metadata;
          const issuer = config.issuer ?? resource.authorization_servers?.[0];
          if (
            !issuer ||
            resource.resource !== resourceUrl.href ||
            !resource.authorization_servers?.includes(issuer)
          )
            return yield* deniedAuth();
          const issuerUrl = yield* validateAuthUrl(issuer, policy);
          if (issuerUrl.search) return yield* deniedAuth();
          const metadata = yield* withAuthFetch(policy, (fetch) =>
            discoverAuthorizationServerMetadata(issuer, { fetchFn: fetch }),
          ).pipe(Effect.provideService(NetworkAddresses, network));
          if (!metadata || metadata.issuer !== issuer) return yield* deniedAuth();
          if (
            !metadata.code_challenge_methods_supported?.includes("S256") ||
            !metadata.response_types_supported.includes("code") ||
            (metadata.token_endpoint_auth_methods_supported &&
              !metadata.token_endpoint_auth_methods_supported.includes("none"))
          )
            return yield* unsupported();
          const authorizationEndpoint = yield* validateAuthUrl(
            metadata.authorization_endpoint,
            policy,
          );
          yield* validateAuthUrl(metadata.token_endpoint, policy);
          yield* authProgress(ui, { phase: "registration", deadline });
          let client: OAuthClientInformationMixed;
          if (config.registration === "pre-registered") {
            if (!config.clientId) return yield* unsupported();
            client = { client_id: config.clientId };
          } else if (config.registration === "metadata") {
            if (
              !config.clientMetadataUrl ||
              metadata.client_id_metadata_document_supported !== true
            )
              return yield* unsupported();
            const metadataUrl = yield* validateAuthUrl(config.clientMetadataUrl, policy);
            yield* sdk(() => validateClientMetadataUrl(metadataUrl.href));
            const addresses = yield* network
              .resolve(metadataUrl.hostname)
              .pipe(Effect.mapError(deniedAuth));
            yield* validateAuthAddresses(metadataUrl, addresses, policy);
            client = { client_id: metadataUrl.href };
          } else {
            if (!metadata.registration_endpoint) return yield* unsupported();
            yield* validateAuthUrl(metadata.registration_endpoint, policy);
            client = yield* withAuthFetch(policy, (fetch) =>
              registerClient(issuer, {
                metadata,
                clientMetadata: {
                  redirect_uris: [redirect],
                  grant_types: ["authorization_code", "refresh_token"],
                  response_types: ["code"],
                  token_endpoint_auth_method: "none",
                  client_name: "Cosmic Pi MCP",
                },
                scope: config.scopes.join(" "),
                fetchFn: fetch,
              }),
            ).pipe(Effect.provideService(NetworkAddresses, network));
            const registered = yield* sdk(() => OAuthClientInformationFullSchema.parse(client));
            if (!registered.redirect_uris.includes(redirect)) return yield* deniedAuth();
          }
          if (!publicClient(client)) return yield* unsupported();
          const state = Encoding.encodeBase64Url(
            yield* crypto.randomBytes(32).pipe(Effect.mapError(deniedAuth)),
          );
          const attempt = yield* Effect.tryPromise({
            try: () =>
              startAuthorization(issuer, {
                metadata,
                clientInformation: client,
                redirectUrl: redirect,
                scope: config.scopes.join(" "),
                state,
                resource: resourceUrl,
              }),
            catch: deniedAuth,
          });
          const authorization = yield* validateAuthUrl(attempt.authorizationUrl.href, policy);
          if (
            authorization.origin !== authorizationEndpoint.origin ||
            authorization.pathname !== authorizationEndpoint.pathname ||
            authorization.searchParams.get("code_challenge_method") !== "S256" ||
            authorization.searchParams.get("state") !== state ||
            authorization.searchParams.get("redirect_uri") !== redirect ||
            authorization.searchParams.get("resource") !== resourceUrl.href
          )
            return yield* deniedAuth();
          const addresses = yield* network
            .resolve(authorization.hostname)
            .pipe(Effect.mapError(deniedAuth));
          yield* validateAuthAddresses(authorization, addresses, policy);
          const consume = singleUseCallback(redirect, state);
          const receive = Effect.suspend(() =>
            listener ? listener.receive : ui.readCallback(authorization.href, deadline),
          );
          const callback = ui.waitForCallback
            ? yield* ui.waitForCallback(authorization.href, deadline, receive)
            : yield* Effect.gen(function* () {
                if (ui.mode === "local")
                  yield* authProgress(ui, { phase: "opening-browser", deadline });
                yield* ui.openBrowser(authorization.href);
                yield* authProgress(ui, { phase: "awaiting-callback", deadline });
                return yield* receive;
              });
          if (!callback)
            return yield* boundaryError("cancelled", "not-sent", "OAuth login was cancelled.");
          yield* authProgress(ui, { phase: "exchange", deadline });
          const response = yield* consume(callback);
          yield* sdk(() =>
            validateAuthorizationResponseIssuer({
              iss: response.iss,
              expectedIssuer: metadata.issuer,
              issParameterSupported:
                metadata.authorization_response_iss_parameter_supported === true,
            }),
          );
          const exchange: Parameters<typeof exchangeAuthorization>[1] = {
            metadata,
            clientInformation: { ...client, token_endpoint_auth_method: "none" },
            authorizationCode: response.code,
            codeVerifier: attempt.codeVerifier,
            redirectUri: redirect,
            resource: resourceUrl,
          };
          if (response.iss !== undefined) exchange.iss = response.iss;
          const tokens = yield* withAuthFetch(policy, (fetch) =>
            exchangeAuthorization(issuer, { ...exchange, fetchFn: fetch }),
          ).pipe(Effect.provideService(NetworkAddresses, network));
          const grant = {
            version: 1 as const,
            identity: server.identity,
            issuer,
            resource: resourceUrl.href,
            clientId: client.client_id,
            registration: config.registration,
            redirectUri: redirect,
            discovery: yield* json(metadata),
            resourceMetadata: yield* json(resource),
            clientInformation: yield* json(client),
          };
          return yield* receipt(
            discovery.source === undefined
              ? grant
              : { ...grant, resourceMetadataSource: discovery.source },
            tokens,
          );
        }),
      ).pipe(
        Effect.timeoutOrElse({
          duration: 180_000,
          orElse: () =>
            Effect.fail(
              boundaryError(
                "timeout",
                "not-sent",
                "OAuth login exceeded its deadline.",
                "oauth-callback-timeout",
              ),
            ),
        }),
      );
    });
  const refresh: McpSdkAuthContract["refresh"] = (server, grant) =>
    Effect.gen(function* () {
      const { metadata, client, tokens } = yield* decode(server, grant);
      if (!tokens.refresh_token) return yield* authFailure();
      const policy = yield* authUrlPolicy(server);
      const updated = yield* withAuthFetch(policy, (fetch) =>
        refreshAuthorization(grant.issuer, {
          metadata,
          clientInformation: client,
          refreshToken: tokens.refresh_token!,
          resource: new URL(grant.resource),
          fetchFn: fetch,
        }),
      ).pipe(
        Effect.provideService(NetworkAddresses, network),
        Effect.mapError(() => authFailure()),
      );
      const { tokens: _tokens, receivedAt: _receivedAt, expiresAt: _expiresAt, ...base } = grant;
      return yield* receipt(base, updated);
    });
  return {
    login,
    refresh,
    token: (server, grant) =>
      decode(server, grant).pipe(Effect.map(({ tokens }) => tokens.access_token)),
  } satisfies McpSdkAuthContract;
});
export class McpSdkAuth extends Context.Service<McpSdkAuth, McpSdkAuthContract>()(
  "pi-mcp/boundary/sdk-auth/McpSdkAuth",
) {
  static readonly layer = Layer.effect(this, makeMcpSdkAuth);
}
