import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { nodeHttpServerLayer } from "pi-cosmic-core";
import type { McpEffectiveServer, McpOAuthConfig } from "../../src/config/model.ts";

interface FixtureDocument {
  [key: string]: Schema.Json;
}
interface FixtureClient {
  clientId?: string;
  clientMetadataUrl?: string;
}
export interface OAuthFixtureOptions {
  readonly dynamic?: boolean;
  readonly metadata?: boolean;
  readonly resourceMismatch?: boolean;
  readonly issuerMismatch?: boolean;
  readonly tokenRedirect?: boolean;
  readonly secretClient?: boolean;
  readonly oversizedMetadata?: boolean;
  readonly unsafeTokenEndpoint?: boolean;
  readonly resourceMetadataStatuses?: ReadonlyArray<number>;
  readonly invalidResourceMetadata?: "json" | "schema";
  readonly oversizedResourceMetadata?: boolean;
  readonly resourceMetadataRedirect?: "private" | "loop";
  readonly unsupportedPkce?: boolean;
  readonly invalidTokens?: boolean;
}
export const startOAuthServer = (options: OAuthFixtureOptions = {}) =>
  Effect.gen(function* () {
    const services = yield* Layer.build(nodeHttpServerLayer({ host: "127.0.0.1", port: 0 }));
    const server = Context.get(services, HttpServer.HttpServer);
    if (server.address._tag !== "TcpAddress")
      return yield* Effect.die("OAuth fixture requires TCP.");
    const origin = `http://127.0.0.1:${server.address.port}`;
    const resource = `${origin}/mcp`;
    const issuer = origin;
    const crypto = yield* Crypto.Crypto;
    const codes = new Map<string, { challenge: string; client: string; redirect: string }>();
    const requests: {
      path: string;
      method: string;
      headers: Readonly<Record<string, string | undefined>>;
    }[] = [];
    let exchanged = 0;
    let refreshed = 0;
    let registered = 0;
    let resourceMetadataRequests = 0;
    let currentRefresh = "fixture-refresh-0";
    const handler = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = new URL(request.url, origin);
      requests.push({ path: url.pathname, method: request.method, headers: request.headers });
      const reply = (value: Schema.Json, status = 200) =>
        HttpServerResponse.jsonUnsafe(value, { status });
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        const statuses = options.resourceMetadataStatuses;
        const status = statuses?.[resourceMetadataRequests++] ?? statuses?.at(-1) ?? 200;
        if (status !== 200) return HttpServerResponse.text("fixture-private-body", { status });
        if (options.invalidResourceMetadata === "json")
          return HttpServerResponse.text("fixture-private-invalid-json");
        if (options.invalidResourceMetadata === "schema")
          return reply({ resource: 123, private: "fixture-private-invalid-schema" });
        if (options.oversizedResourceMetadata) return HttpServerResponse.text("x".repeat(140_000));
        if (options.resourceMetadataRedirect)
          return HttpServerResponse.empty({
            status: 302,
            headers: {
              location:
                options.resourceMetadataRedirect === "private"
                  ? "http://169.254.169.254/metadata"
                  : "/.well-known/oauth-protected-resource/next",
            },
          });
        return reply({
          resource: options.resourceMismatch ? `${origin}/other` : resource,
          authorization_servers: [issuer],
        });
      }
      if (url.pathname.startsWith("/.well-known/")) {
        if (options.oversizedMetadata) return HttpServerResponse.text("x".repeat(140_000));
        const metadata: FixtureDocument = {
          issuer: options.issuerMismatch ? `${origin}/other` : issuer,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: options.unsafeTokenEndpoint
            ? "http://169.254.169.254/token"
            : `${origin}/token`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: options.unsupportedPkce ? ["plain"] : ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          authorization_response_iss_parameter_supported: true,
          client_id_metadata_document_supported: options.metadata !== false,
        };
        if (options.dynamic !== false) metadata.registration_endpoint = `${origin}/register`;
        return reply(metadata);
      }
      if (url.pathname === "/register") {
        registered++;
        const body = yield* request.text;
        const input = yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.Struct({ redirect_uris: Schema.Array(Schema.String) })),
        )(body);
        const registration: FixtureDocument = {
          client_id: "fixture-dynamic-client",
          redirect_uris: input.redirect_uris,
          token_endpoint_auth_method: "none",
        };
        if (options.secretClient) registration.client_secret = "fixture-rejected-secret";
        return reply(registration, 201);
      }
      if (url.pathname === "/authorize") {
        if (
          url.searchParams.get("resource") !== resource ||
          url.searchParams.get("code_challenge_method") !== "S256"
        )
          return reply({ error: "invalid_request" }, 400);
        const code = `fixture-code-${codes.size}`;
        const redirect = url.searchParams.get("redirect_uri") ?? "";
        codes.set(code, {
          challenge: url.searchParams.get("code_challenge") ?? "",
          client: url.searchParams.get("client_id") ?? "",
          redirect,
        });
        const callback = new URL(redirect);
        callback.searchParams.set("code", code);
        callback.searchParams.set("state", url.searchParams.get("state") ?? "");
        callback.searchParams.set("iss", issuer);
        return HttpServerResponse.empty({ status: 302, headers: { location: callback.href } });
      }
      if (url.pathname === "/token") {
        if (options.tokenRedirect)
          return HttpServerResponse.empty({
            status: 307,
            headers: { location: `${origin}/token-replay` },
          });
        const input = new URLSearchParams(yield* request.text);
        if (input.get("resource") !== resource || request.headers.authorization)
          return reply({ error: "invalid_request" }, 400);
        if (input.get("grant_type") === "authorization_code") {
          const code = input.get("code") ?? "";
          const saved = codes.get(code);
          codes.delete(code);
          const challenge = Encoding.encodeBase64Url(
            yield* crypto.digest(
              "SHA-256",
              new TextEncoder().encode(input.get("code_verifier") ?? ""),
            ),
          );
          if (
            !saved ||
            saved.challenge !== challenge ||
            saved.client !== input.get("client_id") ||
            saved.redirect !== input.get("redirect_uri")
          )
            return reply({ error: "invalid_grant" }, 400);
          exchanged++;
        } else if (input.get("grant_type") === "refresh_token") {
          if (input.get("refresh_token") !== currentRefresh)
            return reply({ error: "invalid_grant" }, 400);
          refreshed++;
          currentRefresh = `fixture-refresh-${refreshed}`;
        } else return reply({ error: "unsupported_grant_type" }, 400);
        return reply({
          access_token: `fixture-access-${refreshed}`,
          token_type: options.invalidTokens ? "Basic" : "Bearer",
          refresh_token: currentRefresh,
          expires_in: 3600,
        });
      }
      return HttpServerResponse.empty({ status: 404 });
    }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 500 }))));
    yield* server.serve(handler).pipe(Effect.provide(services));
    const configured = (
      registration: McpOAuthConfig["registration"],
      identity = "a".repeat(64),
    ): McpEffectiveServer => {
      const client: FixtureClient = {};
      if (registration === "pre-registered") client.clientId = "fixture-public-client";
      if (registration === "metadata")
        client.clientMetadataUrl = "https://client.example/metadata.json";
      return {
        id: "fixture",
        identity,
        enabled: true,
        scope: "global",
        directory: "/fixture",
        definition: {
          transport: "http",
          url: resource,
          headers: { "X-Resource-Secret": { value: "must-not-leak" } },
          denyTools: [],
          auth: {
            type: "oauth",
            registration,
            issuer,
            scopes: ["tools"],
            redirectUri: "http://127.0.0.1:49191/callback",
            ...client,
          },
        },
      };
    };
    return {
      origin,
      issuer,
      resource,
      configured,
      requests,
      counts: () => ({ exchanged, refreshed, registered }),
    };
  }).pipe(Effect.provide(NodeCrypto.layer));
