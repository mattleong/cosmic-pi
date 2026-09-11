import {
  registerClient,
  resolveClientMetadata,
  validateClientMetadataUrl,
  type AuthorizationServerMetadata,
  type OAuthClientInformationMixed,
} from "@modelcontextprotocol/client";
import { OAuthClientInformationFullSchema } from "@modelcontextprotocol/core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { NetworkAddresses } from "pi-cosmic-core";
import { registrationReceiptSchema, type McpRegistrationReceipt } from "../auth/credentials.ts";
import type { McpLoginOptions, McpLoginUi } from "../auth/model.ts";
import {
  callbackRedirect,
  deniedAuth,
  validateAuthAddresses,
  validateAuthUrl,
  type AuthUrlPolicy,
} from "../auth/policy.ts";
import { parseScopes, validateScopes } from "../auth/scopes.ts";
import { boundaryError } from "../client/errors.ts";
import type { McpEffectiveServer, McpOAuthConfig } from "../config/model.ts";
import { withAuthFetch } from "./auth-fetch.ts";
import { normalizePublicClient, restorePublicClient } from "./sdk-auth-client.ts";
import { authJson, sdkAuthValue } from "./sdk-auth-grant.ts";

export const unsupportedRegistration = () =>
  boundaryError(
    "unsupported",
    "not-sent",
    "OAuth requires an advertised public-client registration and PKCE flow.",
    "oauth-registration-unsupported",
  );
interface RegistrationInput {
  readonly server: McpEffectiveServer;
  readonly config: McpOAuthConfig;
  readonly issuer: string;
  readonly resource: URL;
  readonly metadata: AuthorizationServerMetadata;
  readonly policy: AuthUrlPolicy;
  readonly redirect: string;
  readonly mode: McpLoginUi["mode"];
  readonly scopes: ReadonlyArray<string>;
  readonly options?: McpLoginOptions | undefined;
}
const compatibleReceipt = (raw: McpRegistrationReceipt, input: RegistrationInput) =>
  Effect.gen(function* () {
    const receipt = yield* Schema.decodeEffect(registrationReceiptSchema)(raw).pipe(
      Effect.mapError(deniedAuth),
    );
    if (receipt.identity !== input.server.identity || receipt.issuer !== input.issuer)
      return yield* deniedAuth();
    const resource = yield* validateAuthUrl(receipt.resource, input.policy);
    if (resource.href !== input.resource.href) return yield* deniedAuth();
    const client = yield* restorePublicClient(receipt.clientInformation);
    const full = yield* sdkAuthValue(() => OAuthClientInformationFullSchema.parse(client));
    const capacity = yield* validateScopes(receipt.scopes);
    const declared = full.scope === undefined ? capacity : yield* parseScopes(full.scope);
    if (
      input.scopes.some((scope) => !capacity.includes(scope) || !declared.includes(scope)) ||
      (full.grant_types && !full.grant_types.includes("authorization_code")) ||
      (full.response_types && !full.response_types.includes("code"))
    )
      return yield* deniedAuth();
    const previous = yield* callbackRedirect(receipt.redirectUri);
    const current = yield* callbackRedirect(input.redirect);
    // Only automatic local native callbacks get RFC 8252's ephemeral IPv4 port exception.
    const configured = yield* callbackRedirect(input.config.redirectUri);
    const ephemeral =
      input.mode === "local" && configured.port === "0" && full.application_type === "native";
    const match = (candidate: URL, expected: URL) =>
      candidate.href === expected.href ||
      (ephemeral &&
        candidate.protocol === expected.protocol &&
        candidate.hostname === expected.hostname &&
        candidate.pathname === expected.pathname &&
        candidate.search === expected.search);
    if (!match(previous, current)) return yield* deniedAuth();
    const redirects = yield* Effect.forEach(full.redirect_uris, (value) => callbackRedirect(value));
    if (
      !redirects.some((redirect) => match(redirect, previous)) ||
      !redirects.some((redirect) => match(redirect, current))
    )
      return yield* deniedAuth();
    return { receipt: { ...receipt, clientInformation: yield* authJson(client) }, client };
  });

/** Reuse is an explicit-login choice. A rejected reused client never triggers automatic DCR retry. */
export const loginClient = (input: RegistrationInput) =>
  Effect.gen(function* () {
    const { config, issuer, metadata, policy, redirect, scopes } = input;
    const network = yield* NetworkAddresses;
    if (config.registration === "pre-registered") {
      if (!config.clientId) return yield* unsupportedRegistration();
      return yield* normalizePublicClient({ client_id: config.clientId });
    }
    if (config.registration === "metadata") {
      if (!config.clientMetadataUrl || metadata.client_id_metadata_document_supported !== true)
        return yield* unsupportedRegistration();
      const url = yield* validateAuthUrl(config.clientMetadataUrl, policy);
      yield* sdkAuthValue(() => validateClientMetadataUrl(url.href));
      const addresses = yield* network.resolve(url.hostname).pipe(Effect.mapError(deniedAuth));
      yield* validateAuthAddresses(url, addresses, policy);
      return yield* normalizePublicClient({ client_id: url.href });
    }
    const previous = input.options?.previousGrant;
    let previousScopes = previous?.requestedScopes;
    if (previous && previousScopes === undefined) {
      previousScopes = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ scope: Schema.optionalKey(Schema.String) }),
      )(previous.clientInformation).pipe(
        Effect.flatMap((client) =>
          client.scope === undefined ? Effect.succeed([]) : parseScopes(client.scope),
        ),
        Effect.orElseSucceed(() => []),
      );
    }
    const candidates: McpRegistrationReceipt[] = [];
    if (input.options?.registration) candidates.push(input.options.registration);
    if (previous?.registration === "dynamic") {
      const restored = yield* restorePublicClient(previous.clientInformation).pipe(Effect.result);
      if (restored._tag === "Success" && restored.success.client_id === previous.clientId)
        candidates.push({
          identity: previous.identity,
          issuer: previous.issuer,
          resource: previous.resource,
          registration: "dynamic",
          redirectUri: previous.redirectUri,
          clientInformation: previous.clientInformation,
          scopes: previousScopes ?? [],
        });
    }
    for (const candidate of candidates) {
      const reusable = yield* compatibleReceipt(candidate, input).pipe(Effect.result);
      if (reusable._tag === "Success") {
        if (input.options?.saveRegistration)
          yield* input.options.saveRegistration(reusable.success.receipt);
        return reusable.success.client;
      }
    }
    if (!metadata.registration_endpoint) return yield* unsupportedRegistration();
    yield* validateAuthUrl(metadata.registration_endpoint, policy);
    const clientMetadata = resolveClientMetadata({
      redirectUrl: redirect,
      clientMetadata: {
        redirect_uris: [redirect],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        client_name: "Cosmic Pi MCP",
      },
    });
    if (metadata.grant_types_supported && !metadata.grant_types_supported.includes("refresh_token"))
      clientMetadata.grant_types = ["authorization_code"];
    const registered: OAuthClientInformationMixed = yield* withAuthFetch(policy, (fetch) => {
      const request: Parameters<typeof registerClient>[1] = {
        metadata,
        clientMetadata,
        fetchFn: fetch,
      };
      if (scopes.length > 0) request.scope = scopes.join(" ");
      return registerClient(issuer, request);
    });
    // Defaults sent in our registration remain evidence when the response omits them. Validate
    // the response first so an omitted public method cannot hide an ambiguous returned secret.
    const normalized = yield* normalizePublicClient(registered);
    const full = yield* sdkAuthValue(() =>
      OAuthClientInformationFullSchema.parse({ ...clientMetadata, ...normalized }),
    );
    if (!full.redirect_uris.includes(redirect)) return yield* deniedAuth();
    const capacity = full.scope === undefined ? [...scopes] : yield* parseScopes(full.scope);
    const receipt: McpRegistrationReceipt = {
      identity: input.server.identity,
      issuer,
      resource: input.resource.href,
      registration: "dynamic",
      redirectUri: redirect,
      clientInformation: yield* authJson(full),
      scopes: capacity,
    };
    const accepted = yield* compatibleReceipt(receipt, input);
    if (input.options?.saveRegistration) yield* input.options.saveRegistration(accepted.receipt);
    return accepted.client;
  });
