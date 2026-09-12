import {
  discoverAuthorizationServerMetadata,
  startAuthorization,
  exchangeAuthorization,
  refreshAuthorization,
  validateAuthorizationResponseIssuer,
} from "@modelcontextprotocol/client";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import { NetworkAddresses } from "pi-cosmic-core";
import type { McpLoginOptions, McpLoginUi } from "../auth/model.ts";
import { authProgress } from "../auth/progress.ts";
import { AuthRequestCurrent } from "../auth/authority.ts";
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
import {
  approveScopes,
  proposeScopes,
  validateAuthorizationScopes,
  type ScopeEvidence,
} from "../auth/scopes.ts";
import { boundaryError, type McpBoundaryError } from "../client/errors.ts";
import type { McpEffectiveServer } from "../config/model.ts";
import { openAuthCallback } from "./auth-callback.ts";
import { withAuthFetch } from "./auth-fetch.ts";
import { discoverAuthResource, missingOnlyMetadataFetch } from "./sdk-auth-discovery.ts";
import {
  authJson as json,
  decodeSdkGrant as decode,
  sdkAuthValue as sdk,
  sdkGrantReceipt as receipt,
} from "./sdk-auth-grant.ts";
import { loginClient, unsupportedRegistration as unsupported } from "./sdk-auth-registration.ts";

export interface McpSdkAuthContract {
  readonly login: (
    server: McpEffectiveServer,
    ui: McpLoginUi,
    options?: McpLoginOptions,
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
  const login: McpSdkAuthContract["login"] = (server, ui, options) =>
    Effect.gen(function* () {
      const checkCurrent = yield* AuthRequestCurrent;
      yield* checkCurrent;
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
          const discovery = yield* discoverAuthResource(
            endpoint,
            resourceUrl,
            config,
            policy,
            options?.challenge,
          ).pipe(Effect.provideService(NetworkAddresses, network));
          const discoveredResource = yield* validateAuthUrl(discovery.metadata.resource, policy);
          if (discoveredResource.href !== resourceUrl.href) return yield* deniedAuth();
          let resource = { ...discovery.metadata, resource: discoveredResource.href };
          let issuer = config.issuer ?? resource.authorization_servers?.[0];
          if (
            !issuer ||
            resource.resource !== resourceUrl.href ||
            !resource.authorization_servers?.includes(issuer)
          )
            return yield* deniedAuth();
          const issuerUrl = yield* validateAuthUrl(issuer, policy);
          if (issuerUrl.search) return yield* deniedAuth();
          const discoveryIssuer = discovery.source === "origin" ? `${issuer}/` : issuer;
          const metadata = yield* withAuthFetch(policy, (fetch) =>
            discoverAuthorizationServerMetadata(discoveryIssuer, {
              fetchFn: missingOnlyMetadataFetch(fetch),
            }),
          ).pipe(Effect.provideService(NetworkAddresses, network));
          if (
            !metadata ||
            (metadata.issuer !== issuer &&
              !(discovery.source === "origin" && metadata.issuer === `${issuer}/`))
          )
            return yield* deniedAuth();
          if (discovery.source === "origin") {
            issuer = metadata.issuer;
            resource = { ...resource, authorization_servers: [issuer] };
          }
          if (!metadata.code_challenge_methods_supported?.includes("S256"))
            return yield* boundaryError(
              "unsupported",
              "not-sent",
              "OAuth metadata does not advertise PKCE S256.",
              "oauth-pkce-unsupported",
            );
          if (
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
          const evidence: ScopeEvidence = { retained: discovery.retained };
          if (discovery.challenge) Object.assign(evidence, { challenge: discovery.challenge });
          if (resource.scopes_supported)
            Object.assign(evidence, { resourceScopes: resource.scopes_supported });
          if (metadata.scopes_supported)
            Object.assign(evidence, { serverScopes: metadata.scopes_supported });
          if (metadata.grant_types_supported)
            Object.assign(evidence, { grantTypes: metadata.grant_types_supported });
          const proposal = yield* proposeScopes(config, evidence);
          if (proposal.additions.length > 0)
            yield* authProgress(ui, { phase: "scope-approval", deadline });
          const scopes = yield* approveScopes(ui, proposal, deadline);
          yield* authProgress(ui, { phase: "registration", deadline });
          yield* checkCurrent;
          const client = yield* loginClient({
            server,
            config,
            issuer,
            resource: resourceUrl,
            metadata,
            policy,
            redirect,
            mode: ui.mode,
            scopes,
            options,
          }).pipe(Effect.provideService(NetworkAddresses, network));
          const state = Encoding.encodeBase64Url(
            yield* crypto.randomBytes(32).pipe(Effect.mapError(deniedAuth)),
          );
          const attempt = yield* Effect.tryPromise({
            try: () =>
              startAuthorization(issuer, {
                metadata,
                clientInformation: client,
                redirectUrl: redirect,
                scope: scopes.join(" "),
                state,
                resource: resourceUrl,
              }),
            catch: deniedAuth,
          });
          // Empty scope must not inherit any authorization endpoint scope query.
          if (scopes.length === 0) attempt.authorizationUrl.searchParams.delete("scope");
          const authorization = yield* validateAuthUrl(attempt.authorizationUrl.href, policy);
          yield* validateAuthorizationScopes(authorization, scopes);
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
          yield* checkCurrent;
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
          yield* checkCurrent;
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
            requestedScopes: [...scopes],
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
      yield* yield* AuthRequestCurrent;
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
      return yield* receipt({ ...base, clientInformation: yield* json(client) }, updated);
    });
  return {
    login,
    refresh,
    token: (server, grant) =>
      decode(server, grant).pipe(
        Effect.tap(() => Effect.flatMap(AuthRequestCurrent, (check) => check)),
        Effect.map(({ tokens }) => tokens.access_token),
      ),
  } satisfies McpSdkAuthContract;
});
export class McpSdkAuth extends Context.Service<McpSdkAuth, McpSdkAuthContract>()(
  "pi-mcp/boundary/sdk-auth/McpSdkAuth",
) {
  static readonly layer = Layer.effect(this, makeMcpSdkAuth);
}
