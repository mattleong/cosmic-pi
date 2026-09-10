import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpMiddleware, HttpServerResponse } from "effect/unstable/http";
import { NetworkAddresses } from "pi-cosmic-core";
import { capturedTelemetrySnapshot, makeCapturedTracer } from "pi-cosmic-core/testing";
import { describe, expect } from "vitest";
import type { McpLoginUi } from "../../src/auth/model.ts";
import type { McpAuthProgressEvent } from "../../src/auth/progress.ts";
import { decodeGrant, encodeGrant, type McpGrant } from "../../src/auth/credentials.ts";
import type { McpEffectiveServer } from "../../src/config/model.ts";
import { makeMcpSdkAuth } from "../../src/boundary/sdk-auth.ts";
import { openAuthCallback } from "../../src/boundary/auth-callback.ts";
import { withAuthFetch } from "../../src/boundary/auth-fetch.ts";
import { authUrlPolicy } from "../../src/auth/policy.ts";
import { boundaryError } from "../../src/client/errors.ts";
import { startOAuthServer } from "../fixtures/oauth-server.ts";
import { startHttpServer } from "../fixtures/http-server.ts";

const serialize = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const network = Layer.succeed(NetworkAddresses, {
  resolve: (hostname) =>
    Effect.succeed(
      hostname === "client.example"
        ? [{ address: "93.184.216.34", family: 4 as const }]
        : [{ address: "127.0.0.1", family: 4 as const }],
    ),
});
const layers = Layer.mergeAll(network, NodeCrypto.layer, NodeHttpClient.layerNodeHttp);
const browser = (mode: "local" | "manual", mutate: (callback: string) => string = (s) => s) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    let callback: string | undefined;
    return {
      mode,
      openBrowser: (url: string) =>
        client.get(url).pipe(
          Effect.flatMap((response) => {
            callback = mutate(response.headers.location ?? "");
            return mode === "local" ? client.get(callback).pipe(Effect.asVoid) : Effect.void;
          }),
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
          Effect.mapError(() =>
            boundaryError("unavailable", "not-sent", "Fixture browser failed."),
          ),
        ),
      readCallback: () => Effect.succeed(callback),
    } satisfies McpLoginUi;
  });

describe("SDK-owned public OAuth", () => {
  it.live(
    "acknowledges receipt without reflecting callback values or claiming sign-in success",
    () =>
      Effect.gen(function* () {
        const callback = yield* openAuthCallback("http://127.0.0.1:0/callback");
        const client = yield* HttpClient.HttpClient;
        const privateUrl = `${callback.redirectUri}?code=PRIVATE_CODE&state=PRIVATE_STATE`;
        const response = yield* client.get(privateUrl);
        const html = yield* response.text;
        expect(response.headers["content-type"]).toContain("text/html");
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.headers["referrer-policy"]).toBe("no-referrer");
        expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
        expect(html).not.toMatch(/PRIVATE_|<script|https?:|signed in|sign-in succeeded/i);
        expect(yield* callback.receive).toBe(privateUrl);
        expect((yield* client.get(privateUrl)).status).toBe(404);
      }).pipe(
        Effect.provide(layers),
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
      ),
  );

  for (const mode of ["safe", "private", "loop"] as const) {
    it.live(`validates and bounds each metadata redirect: ${mode}`, () =>
      Effect.gen(function* () {
        let visits = 0;
        const fixture = yield* startHttpServer(() =>
          Effect.sync(() => {
            visits++;
            if (mode === "safe" && visits === 2) return HttpServerResponse.text("accepted");
            return HttpServerResponse.empty({
              status: 302,
              headers: {
                location: mode === "private" ? "https://private.example/metadata" : "/next",
              },
            });
          }),
        );
        const policy = {
          privateOrigins: new Set([fixture.url.origin]),
          localHttpOrigins: new Set([fixture.url.origin]),
        };
        const result = yield* withAuthFetch(policy, (fetch) =>
          fetch(fixture.url).then((response) => response.text()),
        ).pipe(Effect.result);
        if (mode === "safe") expect(result._tag === "Success" && result.success).toBe("accepted");
        else expect(result._tag === "Failure" && result.failure.kind).toBe("denied");
        expect(visits).toBe(mode === "safe" ? 2 : mode === "private" ? 1 : 4);
      }).pipe(Effect.provide(layers)),
    );
  }
  for (const registration of ["pre-registered", "metadata"] as const) {
    it.effect(
      `restores canonical resource and ${registration} client bindings without rewriting opaque IDs`,
      () =>
        Effect.gen(function* () {
          const sdk = yield* makeMcpSdkAuth;
          const clientId =
            registration === "metadata"
              ? "https://client.example/oauth.json"
              : "https://opaque.example:443";
          const configuredClient =
            registration === "metadata"
              ? { clientMetadataUrl: "https://client.example:443/oauth.json" }
              : { clientId };
          const server: McpEffectiveServer = {
            id: "normalized",
            identity: "a".repeat(64),
            enabled: true,
            scope: "global",
            directory: "/fixture",
            definition: {
              transport: "http",
              url: "https://api.example",
              headers: {},
              denyTools: [],
              auth: {
                type: "oauth",
                registration,
                issuer: "https://issuer.example",
                scopes: [],
                ...configuredClient,
              },
            },
          };
          const grant: McpGrant = {
            version: 1,
            identity: server.identity,
            issuer: "https://issuer.example",
            resource: "https://api.example/",
            clientId,
            registration,
            redirectUri: "http://127.0.0.1:9000/callback",
            receivedAt: 0,
            discovery: {
              issuer: "https://issuer.example",
              authorization_endpoint: "https://issuer.example/authorize",
              token_endpoint: "https://issuer.example/token",
              response_types_supported: ["code"],
            },
            resourceMetadata: {
              resource: "https://api.example/",
              authorization_servers: ["https://issuer.example"],
            },
            clientInformation: { client_id: clientId },
            tokens: { token_type: "Bearer", access_token: "fixture-restored" },
          };
          expect(yield* sdk.token(server, grant)).toBe("fixture-restored");
          expect(
            (yield* sdk
              .token(server, { ...grant, issuer: "https://issuer.example/" })
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
          if (registration === "pre-registered")
            expect(
              (yield* sdk
                .token(server, {
                  ...grant,
                  clientId: "https://opaque.example/",
                  clientInformation: { client_id: "https://opaque.example/" },
                })
                .pipe(Effect.result))._tag,
            ).toBe("Failure");
        }).pipe(Effect.provide(layers)),
    );
  }
  for (const registration of ["pre-registered", "dynamic", "metadata"] as const) {
    for (const mode of ["manual", "local"] as const) {
      it.live(
        `${registration} completes ${mode} callback, PKCE exchange, persisted restoration and refresh`,
        () =>
          Effect.gen(function* () {
            const fixture = yield* startOAuthServer();
            const sdk = yield* makeMcpSdkAuth;
            const configured = fixture.configured(registration);
            const server =
              mode === "local" &&
              configured.definition?.transport === "http" &&
              configured.definition.auth.type === "oauth"
                ? {
                    ...configured,
                    definition: {
                      ...configured.definition,
                      auth: {
                        ...configured.definition.auth,
                        redirectUri: "http://127.0.0.1:0/callback",
                      },
                    },
                  }
                : configured;
            const ui = yield* browser(mode);
            const progress: McpAuthProgressEvent[] = [];
            const grant = yield* sdk.login(server, {
              ...ui,
              progress: (event) =>
                Effect.sync(() => {
                  progress.push(event);
                }),
            });
            expect(progress.map((event) => event.phase)).toEqual(
              mode === "local"
                ? [
                    "callback-listener",
                    "discovery",
                    "registration",
                    "opening-browser",
                    "awaiting-callback",
                    "exchange",
                  ]
                : ["discovery", "registration", "awaiting-callback", "exchange"],
            );
            expect(new Set(progress.map((event) => event.deadline)).size).toBe(1);
            expect(progress.every((event) => event.deadline !== undefined)).toBe(true);
            expect(yield* serialize(progress)).not.toMatch(
              /fixture-access|fixture-code|code_challenge|https?:/,
            );
            expect(yield* sdk.token(server, grant)).toBe("fixture-access-0");
            expect(grant.version).toBe(1);
            expect(grant.expiresAt! - grant.receivedAt).toBe(3_600_000);
            const refreshed = yield* sdk.refresh(server, grant);
            expect(yield* sdk.token(server, refreshed)).toBe("fixture-access-1");
            expect(fixture.counts()).toEqual({
              exchanged: 1,
              refreshed: 1,
              registered: registration === "dynamic" ? 1 : 0,
            });
            expect(
              fixture.requests.every(
                (request) =>
                  !request.headers["x-resource-secret"] && !request.headers.authorization,
              ),
            ).toBe(true);
          }).pipe(Effect.provide(layers)),
      );
    }
  }
  for (const statuses of [
    [404, 404],
    [404, 410],
  ]) {
    it.live(
      `configured resource metadata survives login, persistence and refresh: ${statuses}`,
      () =>
        Effect.gen(function* () {
          const fixture = yield* startOAuthServer({ resourceMetadataStatuses: statuses });
          const sdk = yield* makeMcpSdkAuth;
          const configured = fixture.configured("dynamic");
          if (
            configured.definition?.transport !== "http" ||
            configured.definition.auth.type !== "oauth"
          )
            return yield* Effect.die("Fixture OAuth definition missing.");
          const definition = configured.definition;
          const auth = definition.auth;
          const server = {
            ...configured,
            definition: {
              ...definition,
              auth: { ...auth, allowMissingResourceMetadata: true },
            },
          };
          const grant = yield* sdk.login(server, yield* browser("manual"));
          expect(grant.resourceMetadataSource).toBe("configured");
          const stored = yield* decodeGrant(yield* encodeGrant(grant));
          const restored = yield* makeMcpSdkAuth;
          expect(yield* restored.token(server, stored)).toBe("fixture-access-0");
          const refreshed = yield* restored.refresh(server, stored);
          expect(refreshed.resourceMetadataSource).toBe("configured");
          expect(yield* restored.token(server, refreshed)).toBe("fixture-access-1");
          expect(fixture.counts()).toEqual({ registered: 1, exchanged: 1, refreshed: 1 });
          // Keep identity unchanged here to exercise restore policy independently of config hashing.
          for (const changedAuth of [
            auth,
            { ...auth, allowMissingResourceMetadata: false },
            { ...auth, allowMissingResourceMetadata: true, issuer: `${fixture.issuer}/other` },
            { ...auth, allowMissingResourceMetadata: true, resource: `${fixture.origin}/other` },
            {
              type: "oauth" as const,
              registration: "dynamic" as const,
              scopes: [],
              allowMissingResourceMetadata: true,
            },
          ]) {
            const changed = { ...configured, definition: { ...definition, auth: changedAuth } };
            expect((yield* restored.token(changed, refreshed).pipe(Effect.result))._tag).toBe(
              "Failure",
            );
            expect((yield* restored.refresh(changed, refreshed).pipe(Effect.result))._tag).toBe(
              "Failure",
            );
          }
          expect(fixture.counts().refreshed).toBe(1);
        }).pipe(Effect.provide(layers)),
    );
  }

  for (const options of [
    { resourceMismatch: true },
    { issuerMismatch: true, resourceMetadataStatuses: [404] },
    { unsupportedPkce: true, resourceMetadataStatuses: [404] },
    { secretClient: true, resourceMetadataStatuses: [404] },
  ]) {
    it.live(
      `compatibility does not relax OAuth binding or client policy: ${JSON.stringify(options)}`,
      () =>
        Effect.gen(function* () {
          const fixture = yield* startOAuthServer(options);
          const sdk = yield* makeMcpSdkAuth;
          const configured = fixture.configured("dynamic");
          if (
            configured.definition?.transport !== "http" ||
            configured.definition.auth.type !== "oauth"
          )
            return yield* Effect.die("Fixture OAuth definition missing.");
          const server = {
            ...configured,
            definition: {
              ...configured.definition,
              auth: { ...configured.definition.auth, allowMissingResourceMetadata: true },
            },
          };
          const result = yield* sdk.login(server, yield* browser("manual")).pipe(Effect.result);
          expect(result._tag).toBe("Failure");
          expect(fixture.counts().exchanged).toBe(0);
          expect(yield* serialize(result)).not.toContain("fixture-rejected-secret");
        }).pipe(Effect.provide(layers)),
    );
  }

  for (const failure of ["state", "issuer", "tokens"] as const) {
    it.live(`configured fallback still rejects invalid ${failure}`, () =>
      Effect.gen(function* () {
        const fixture = yield* startOAuthServer({
          resourceMetadataStatuses: [404],
          invalidTokens: failure === "tokens",
        });
        const sdk = yield* makeMcpSdkAuth;
        const configured = fixture.configured("pre-registered");
        if (
          configured.definition?.transport !== "http" ||
          configured.definition.auth.type !== "oauth"
        )
          return yield* Effect.die("Fixture OAuth definition missing.");
        const server = {
          ...configured,
          definition: {
            ...configured.definition,
            auth: { ...configured.definition.auth, allowMissingResourceMetadata: true },
          },
        };
        const parameter = failure === "issuer" ? "iss" : "state";
        const ui = yield* browser("manual", (callback) =>
          failure === "tokens" ? callback : callback.replace(`${parameter}=`, `${parameter}=wrong`),
        );
        const result = yield* sdk.login(server, ui).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(fixture.counts().exchanged).toBe(failure === "tokens" ? 1 : 0);
        expect(yield* serialize(result)).not.toMatch(/fixture-access|fixture-code/);
      }).pipe(Effect.provide(layers)),
    );
  }

  for (const mutation of [
    (value: string) => value.replace("state=", "state=wrong"),
    (value: string) => `${value}&state=duplicate`,
    (value: string) => value.replace("iss=", "iss=wrong"),
    (value: string) => value.replace("/callback?", "/other?"),
    (value: string) => value.split("&iss=")[0]!,
  ]) {
    it.live("rejects callback binding before exchange without leaking the code", () =>
      Effect.gen(function* () {
        const fixture = yield* startOAuthServer();
        const sdk = yield* makeMcpSdkAuth;
        const result = yield* sdk
          .login(fixture.configured("pre-registered"), yield* browser("manual", mutation))
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(fixture.counts().exchanged).toBe(0);
        expect(result._tag === "Failure" && result.failure.message).not.toContain("fixture-code");
      }).pipe(Effect.provide(layers)),
    );
  }
  for (const options of [
    { dynamic: false },
    { metadata: false },
    { secretClient: true },
    { resourceMismatch: true },
    { issuerMismatch: true },
    { tokenRedirect: true },
    { oversizedMetadata: true },
    { unsafeTokenEndpoint: true },
  ]) {
    it.live(`rejects unsafe or unsupported discovery ${JSON.stringify(options)}`, () =>
      Effect.gen(function* () {
        const fixture = yield* startOAuthServer(options);
        const sdk = yield* makeMcpSdkAuth;
        const registration = "metadata" in options ? "metadata" : "dynamic";
        const result = yield* sdk
          .login(fixture.configured(registration), yield* browser("manual"))
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(fixture.counts().exchanged).toBe(0);
        expect(fixture.requests.some((request) => request.path === "/token-replay")).toBe(false);
      }).pipe(Effect.provide(layers)),
    );
  }
  it.live("closes a local callback listener when login is interrupted before callback", () =>
    Effect.gen(function* () {
      const fixture = yield* startOAuthServer();
      const sdk = yield* makeMcpSdkAuth;
      const opened = yield* Deferred.make<string>();
      const configured = fixture.configured("pre-registered");
      if (
        configured.definition?.transport !== "http" ||
        configured.definition.auth.type !== "oauth"
      )
        return yield* Effect.die("Missing fixture definition.");
      const server = {
        ...configured,
        definition: {
          ...configured.definition,
          auth: { ...configured.definition.auth, redirectUri: "http://127.0.0.1:0/callback" },
        },
      };
      const login = yield* sdk
        .login(server, {
          mode: "local",
          openBrowser: (url) => Deferred.succeed(opened, url).pipe(Effect.andThen(Effect.never)),
          readCallback: () => Effect.succeed(undefined),
        })
        .pipe(Effect.forkScoped);
      const authorization = new URL(yield* Deferred.await(opened));
      const redirect = authorization.searchParams.get("redirect_uri")!;
      const client = yield* HttpClient.HttpClient;
      expect((yield* client.get(new URL("/other", redirect))).status).toBe(404);
      yield* Fiber.interrupt(login);
      expect((yield* client.get(redirect).pipe(Effect.result))._tag).toBe("Failure");
      expect(fixture.counts().exchanged).toBe(0);
    }).pipe(Effect.provide(layers)),
  );
  for (const mode of ["interrupt", "deadline"] as const) {
    it.effect(`cancels an owned HTTP request on ${mode} and joins remote request cleanup`, () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const closed = yield* Deferred.make<void>();
        const fixture = yield* startHttpServer(() =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(closed, undefined)),
          ),
        );
        const origin = fixture.url.origin;
        const policy = { privateOrigins: new Set([origin]), localHttpOrigins: new Set([origin]) };
        const request = yield* withAuthFetch(policy, (fetch) => fetch(fixture.url)).pipe(
          Effect.result,
          Effect.forkScoped,
        );
        yield* Deferred.await(entered);
        if (mode === "interrupt") yield* Fiber.interrupt(request);
        else {
          yield* TestClock.adjust(15_000);
          const result = yield* Fiber.join(request);
          expect(result._tag === "Failure" && result.failure.kind).toBe("timeout");
        }
        yield* Deferred.await(closed);
      }).pipe(Effect.provide(layers)),
    );
  }
  it.live("keeps callback URLs and OAuth requests out of ambient HTTP tracing", () => {
    const trace = makeCapturedTracer();
    return Effect.gen(function* () {
      const fixture = yield* startOAuthServer().pipe(
        Effect.provideService(HttpMiddleware.TracerDisabledWhen, () => true),
      );
      const sdk = yield* makeMcpSdkAuth;
      const configured = fixture.configured("dynamic");
      if (
        configured.definition?.transport !== "http" ||
        configured.definition.auth.type !== "oauth"
      )
        return yield* Effect.die("Fixture OAuth definition missing.");
      const server = {
        ...configured,
        definition: {
          ...configured.definition,
          auth: { ...configured.definition.auth, redirectUri: "http://127.0.0.1:0/callback" },
        },
      };
      const grant = yield* sdk.login(server, yield* browser("local"));
      yield* sdk.refresh(server, grant);
      const snapshot = capturedTelemetrySnapshot(trace);
      expect(snapshot).not.toMatch(
        /127\.0\.0\.1|fixture-code|fixture-access|fixture-refresh|state=/,
      );
    }).pipe(Effect.provide(Layer.merge(layers, trace.layer)));
  });
  it.live("does not let SDK fallback swallow a denied request", () =>
    Effect.gen(function* () {
      const fixture = yield* startOAuthServer();
      const policy = yield* authUrlPolicy(fixture.configured("pre-registered"));
      const result = yield* withAuthFetch(policy, (fetch) =>
        fetch("http://169.254.169.254/metadata").then(
          () => "fallback",
          () => "fallback",
        ),
      ).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
    }).pipe(Effect.provide(layers)),
  );
});
