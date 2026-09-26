import { getEventListeners } from "node:events";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpMiddleware, HttpServerResponse } from "effect/unstable/http";
import { NetworkAddresses } from "pi-cosmic-core";
import { capturedTelemetrySnapshot, makeCapturedTracer } from "pi-cosmic-core/testing";
import { describe, expect } from "vitest";
import type { McpLoginUi, McpScopeProposal } from "../../src/auth/model.ts";
import type { McpAuthProgressEvent } from "../../src/auth/progress.ts";
import type { McpGrant, McpRegistrationReceipt } from "../../src/auth/credentials.ts";
import {
  decodeCredentialRecord,
  encodeCredentialRecord,
} from "../../src/auth/credential-record.ts";
import { makeMcpSdkAuth } from "../../src/boundary/sdk-auth.ts";
import { openAuthCallback } from "../../src/boundary/auth-callback.ts";
import { withAuthFetch } from "../../src/boundary/auth-fetch.ts";
import { AuthRequestCurrent } from "../../src/auth/authority.ts";
import { authUrlPolicy } from "../../src/auth/policy.ts";
import { boundaryError } from "../../src/client/errors.ts";
import { manualUi } from "../fixtures/auth.ts";
import { startOAuthServer } from "../fixtures/oauth-server.ts";
import { startHttpServer } from "../fixtures/http-server.ts";
import { blockingProbe } from "../fixtures/probes.ts";
import { httpDefinition, testServer } from "../fixtures/services.ts";

const serialize = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const persist = (grant: McpGrant) => encodeCredentialRecord({ version: 2, grant });
const restore = (raw: string) =>
  decodeCredentialRecord(raw).pipe(Effect.map((record) => record.grant!));
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

const cancelledUi: McpLoginUi = { ...manualUi, waitForCallback: () => Effect.succeed(undefined) };

describe("explicit OAuth permissions and registration checkpoints", () => {
  it.live(
    "uses the original POST hint and privately approves inferred permissions and offline access",
    () =>
      Effect.gen(function* () {
        const fixture = yield* startOAuthServer({
          resourceScopes: ["admin"],
          serverScopes: ["admin", "offline_access"],
          requireOfflineAccess: true,
        });
        const server = fixture.configured("dynamic", { scopes: [] });
        const sdk = yield* makeMcpSdkAuth;
        const ui = yield* browser("manual");
        const proposals: McpScopeProposal[] = [];
        const progress: McpAuthProgressEvent[] = [];
        const grant = yield* sdk.login(
          server,
          {
            ...ui,
            approveScopes: (proposal) =>
              Effect.sync(() => {
                proposals.push(proposal);
                return true;
              }),
            progress: (event) =>
              Effect.sync(() => {
                progress.push(event);
              }),
            openBrowser: (value) =>
              Effect.sync(() => {
                expect(new URL(value).searchParams.getAll("scope")).toEqual([
                  "offline_access read",
                ]);
              }).pipe(Effect.andThen(ui.openBrowser(value))),
          },
          {
            challenge: {
              status: 401,
              wwwAuthenticate: `Bearer resource_metadata="${fixture.origin}/oauth/resource", scope="read"`,
            },
          },
        );
        expect(grant.requestedScopes).toEqual(["offline_access", "read"]);
        expect(grant.tokens).toHaveProperty("refresh_token");
        expect(proposals).toEqual([
          {
            requested: ["offline_access", "read"],
            additions: ["offline_access", "read"],
            source: "challenge",
          },
        ]);
        expect(progress.some((event) => event.phase === "scope-approval")).toBe(true);
        expect(yield* serialize(progress)).not.toMatch(/offline_access|admin|"read"/);
        expect(fixture.requests.some((request) => request.path === "/mcp")).toBe(false);
        expect(
          fixture.requests.some((request) =>
            request.path.startsWith("/.well-known/oauth-protected-resource"),
          ),
        ).toBe(false);
      }).pipe(Effect.provide(layers)),
  );

  for (const approval of ["missing", "declined", "stale"] as const)
    it.live(`does not register, open, or exchange after ${approval} permission approval`, () =>
      Effect.gen(function* () {
        const fixture = yield* startOAuthServer({ resourceScopes: ["read"] });
        const server = fixture.configured("dynamic", { scopes: [] });
        const sdk = yield* makeMcpSdkAuth;
        let opened = false;
        const ui: McpLoginUi = {
          ...cancelledUi,
          openBrowser: () =>
            Effect.sync(() => {
              opened = true;
            }),
        };
        if (approval !== "missing")
          Object.assign(ui, {
            approveScopes: () =>
              approval === "stale"
                ? Effect.fail(boundaryError("stale", "not-sent", "Fixture consent revoked."))
                : Effect.succeed(false),
          });
        expect(yield* sdk.login(server, ui).pipe(Effect.isFailure)).toBe(true);
        expect(opened).toBe(false);
        expect(fixture.counts()).toEqual({ registered: 0, exchanged: 0, refreshed: 0 });
      }).pipe(Effect.provide(layers)),
    );

  it.live("cancellation interrupts permission approval before registration", () =>
    Effect.gen(function* () {
      const fixture = yield* startOAuthServer({ resourceScopes: ["read"] });
      const sdk = yield* makeMcpSdkAuth;
      const approval = yield* blockingProbe;
      const login = yield* sdk
        .login(fixture.configured("dynamic", { scopes: [] }), {
          ...cancelledUi,
          approveScopes: () => approval.block,
        })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(approval.entered);
      yield* Fiber.interrupt(login);
      expect(approval.released()).toBe(true);
      expect(fixture.counts()).toEqual({ registered: 0, exchanged: 0, refreshed: 0 });
    }).pipe(Effect.provide(layers)),
  );

  it.live("explicit empty scopes remove all endpoint scopes without inferring permissions", () =>
    Effect.gen(function* () {
      const fixture = yield* startOAuthServer({
        resourceScopes: ["read"],
        serverScopes: ["offline_access"],
        authorizationScopeQuery: "?scope=admin&scope=write",
        requireNoScope: true,
      });
      const sdk = yield* makeMcpSdkAuth;
      const ui = yield* browser("manual");
      const grant = yield* sdk.login(
        fixture.configured("dynamic", { scopes: [], explicitEmptyScopes: true }),
        {
          ...ui,
          openBrowser: (value) =>
            Effect.sync(() => {
              expect(new URL(value).searchParams.has("scope")).toBe(false);
            }).pipe(Effect.andThen(ui.openBrowser(value))),
        },
      );
      expect(grant.requestedScopes).toEqual([]);
    }).pipe(Effect.provide(layers)),
  );

  it.live(
    "omits DCR and authorization scope when no configured or advertised permissions exist",
    () =>
      Effect.gen(function* () {
        const fixture = yield* startOAuthServer({ requireNoScope: true });
        const sdk = yield* makeMcpSdkAuth;
        const grant = yield* sdk.login(
          fixture.configured("dynamic", { scopes: [] }),
          yield* browser("manual"),
        );
        expect(grant.requestedScopes).toEqual([]);
        expect(fixture.counts()).toEqual({ registered: 1, exchanged: 1, refreshed: 0 });
      }).pipe(Effect.provide(layers)),
  );

  it.live("only retained insufficient-scope evidence can add to a configured baseline", () =>
    Effect.gen(function* () {
      const fixture = yield* startOAuthServer({ resourceScopes: ["admin"] });
      const sdk = yield* makeMcpSdkAuth;
      const ui = yield* browser("manual");
      let proposal: McpScopeProposal | undefined;
      const grant = yield* sdk.login(
        fixture.configured("pre-registered"),
        {
          ...ui,
          approveScopes: (value) =>
            Effect.sync(() => {
              proposal = value;
              return true;
            }),
        },
        {
          challenge: {
            status: 403,
            wwwAuthenticate: 'Bearer error="insufficient_scope", scope="write"',
          },
        },
      );
      expect(proposal).toEqual({
        requested: ["tools", "write"],
        additions: ["write"],
        source: "challenge",
      });
      expect(grant.requestedScopes).toEqual(["tools", "write"]);
    }).pipe(Effect.provide(layers)),
  );

  it.live("canonicalizes root resource spellings without relaxing path or query bindings", () =>
    Effect.gen(function* () {
      const fixture = yield* startOAuthServer({ resourceRoot: true });
      const sdk = yield* makeMcpSdkAuth;
      const server = fixture.configured("pre-registered");
      const grant = yield* sdk.login(server, yield* browser("manual"));
      expect(grant.resource).toBe(`${fixture.origin}/`);
      expect(
        yield* sdk.token(server, {
          ...grant,
          resourceMetadata: { resource: fixture.origin, authorization_servers: [fixture.issuer] },
        }),
      ).toBe("fixture-access-0");
      for (const resource of [
        `${fixture.origin}/other`,
        `${fixture.origin}/?tenant=x`,
        `${fixture.origin}/ `,
      ])
        expect(
          yield* sdk
            .token(server, {
              ...grant,
              resourceMetadata: { resource, authorization_servers: [fixture.issuer] },
            })
            .pipe(Effect.isFailure),
        ).toBe(true);
    }).pipe(Effect.provide(layers)),
  );

  for (const mode of ["manual", "local"] as const)
    it.live(`checkpoints and reuses a sanitized registration after cancelled ${mode} sign-in`, () =>
      Effect.gen(function* () {
        const fixture = yield* startOAuthServer({ secretClient: true });
        const sdk = yield* makeMcpSdkAuth;
        const server = fixture.configured(
          "dynamic",
          mode === "local" ? { redirectUri: "http://127.0.0.1:0/callback" } : {},
        );
        let registration: McpRegistrationReceipt | undefined;
        const saveRegistration = (value: McpRegistrationReceipt) =>
          Effect.sync(() => {
            registration = value;
          });
        expect(
          yield* sdk
            .login(server, { ...cancelledUi, mode }, { saveRegistration })
            .pipe(Effect.flip),
        ).toMatchObject({ kind: "cancelled" });
        expect(registration).toBeDefined();
        expect(registration!.clientInformation).toHaveProperty("application_type", "native");
        expect(registration!.clientInformation).not.toHaveProperty("client_secret");
        const grant = yield* sdk.login(server, yield* browser(mode), {
          registration: registration!,
          saveRegistration,
        });
        expect(fixture.counts()).toEqual({ registered: 1, exchanged: 1, refreshed: 0 });
        const refreshed = yield* sdk.refresh(server, grant);
        expect(refreshed.clientInformation).toHaveProperty("redirect_uris");
        expect(refreshed.clientInformation).toHaveProperty("application_type", "native");
        // A completed grant is also a compatible candidate when no separate checkpoint exists.
        yield* sdk.login(server, yield* browser(mode), { previousGrant: refreshed });
        expect(fixture.counts().registered).toBe(1);
        const quarantined = { ...grant, quarantine: "refresh" as const };
        expect(yield* sdk.token(server, quarantined).pipe(Effect.flip)).toMatchObject({
          reason: "oauth-refresh-unresolved",
        });
        expect(yield* sdk.refresh(server, quarantined).pipe(Effect.flip)).toMatchObject({
          reason: "oauth-refresh-unresolved",
        });
      }).pipe(Effect.provide(layers)),
    );

  it.live("reuses legacy completed grants only with consistent full client metadata evidence", () =>
    Effect.gen(function* () {
      const fixture = yield* startOAuthServer({ registrationScope: "tools" });
      const sdk = yield* makeMcpSdkAuth;
      const server = fixture.configured("dynamic");
      const grant = yield* sdk.login(server, yield* browser("manual"));
      const { requestedScopes: _requestedScopes, ...legacy } = grant;
      yield* sdk.login(server, yield* browser("manual"), { previousGrant: legacy });
      expect(fixture.counts().registered).toBe(1);
      yield* sdk
        .login(server, cancelledUi, { previousGrant: { ...legacy, clientId: "different-client" } })
        .pipe(Effect.result);
      expect(fixture.counts().registered).toBe(2);
    }).pipe(Effect.provide(layers)),
  );

  it.live(
    "rejects receipt identity, issuer, resource, method and fixed redirect mismatches before reuse",
    () =>
      Effect.gen(function* () {
        const fixture = yield* startOAuthServer();
        const sdk = yield* makeMcpSdkAuth;
        const server = fixture.configured("dynamic");
        let receipt: McpRegistrationReceipt | undefined;
        yield* sdk
          .login(server, cancelledUi, {
            saveRegistration: (value) =>
              Effect.sync(() => {
                receipt = value;
              }),
          })
          .pipe(Effect.result);
        const original = receipt!;
        const variants: McpRegistrationReceipt[] = [
          { ...original, identity: "b".repeat(64) },
          { ...original, issuer: `${fixture.issuer}/other` },
          { ...original, resource: `${fixture.resource}?tenant=other` },
          { ...original, redirectUri: "http://127.0.0.1:49192/callback" },
          {
            ...original,
            clientInformation: {
              client_id: "fixture-dynamic-client",
              redirect_uris: [original.redirectUri],
              token_endpoint_auth_method: "client_secret_post",
            },
          },
        ];
        for (const registration of variants)
          yield* sdk.login(server, cancelledUi, { registration }).pipe(Effect.result);
        expect(fixture.counts()).toEqual({
          registered: 1 + variants.length,
          exchanged: 0,
          refreshed: 0,
        });
      }).pipe(Effect.provide(layers)),
  );

  it.live("checkpoint failure stops before browser admission", () =>
    Effect.gen(function* () {
      const fixture = yield* startOAuthServer();
      const sdk = yield* makeMcpSdkAuth;
      let opened = false;
      const failed = yield* sdk
        .login(
          fixture.configured("dynamic"),
          {
            ...cancelledUi,
            openBrowser: () =>
              Effect.sync(() => {
                opened = true;
              }),
          },
          {
            saveRegistration: () =>
              Effect.fail(boundaryError("unavailable", "not-sent", "Fixture storage failed.")),
          },
        )
        .pipe(Effect.isFailure);
      expect(failed).toBe(true);
      expect(opened).toBe(false);
      expect(fixture.counts()).toEqual({ registered: 1, exchanged: 0, refreshed: 0 });
    }).pipe(Effect.provide(layers)),
  );

  it.live(
    "incompatible scope capacity creates a new registration, but a rejected reused client never retries",
    () =>
      Effect.gen(function* () {
        const fixture = yield* startOAuthServer({ rejectClient: true });
        const sdk = yield* makeMcpSdkAuth;
        const server = fixture.configured("dynamic");
        let registration: McpRegistrationReceipt | undefined;
        const saveRegistration = (value: McpRegistrationReceipt) =>
          Effect.sync(() => {
            registration = value;
          });
        yield* sdk.login(server, cancelledUi, { saveRegistration }).pipe(Effect.result);
        const first = registration!;
        yield* sdk
          .login(server, cancelledUi, { registration: { ...first, scopes: [] }, saveRegistration })
          .pipe(Effect.result);
        expect(fixture.counts().registered).toBe(2);
        expect(
          yield* sdk
            .login(server, yield* browser("manual"), { registration: registration! })
            .pipe(Effect.isFailure),
        ).toBe(true);
        expect(fixture.counts().registered).toBe(2);
        expect(fixture.counts().exchanged).toBe(0);
      }).pipe(Effect.provide(layers)),
  );
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
          const server = testServer("normalized", {
            identity: "a".repeat(64),
            definition: httpDefinition({
              url: "https://api.example",
              auth: {
                type: "oauth",
                registration,
                issuer: "https://issuer.example",
                scopes: [],
                ...configuredClient,
              },
            }),
          });
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
          const rejects = (changed: McpGrant) => sdk.token(server, changed).pipe(Effect.isFailure);
          expect(yield* rejects({ ...grant, issuer: "https://issuer.example/" })).toBe(true);
          if (registration === "pre-registered")
            expect(
              yield* rejects({
                ...grant,
                clientId: "https://opaque.example/",
                clientInformation: { client_id: "https://opaque.example/" },
              }),
            ).toBe(true);
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
            const server = fixture.configured(
              registration,
              mode === "local" ? { redirectUri: "http://127.0.0.1:0/callback" } : {},
            );
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
  it.live(
    "challenge metadata supports login, persisted restoration and refresh without expanding scopes or headers",
    () =>
      Effect.gen(function* () {
        const fixture = yield* startOAuthServer({
          resourceChallenge: (origin) =>
            `Bearer resource_metadata="${origin}/oauth/resource", scope="admin"`,
          resourceMetadataStatuses: [404],
        });
        const configured = fixture.configured("pre-registered");
        if (configured.definition?.transport !== "http")
          return yield* Effect.die("Missing fixture definition.");
        const server = {
          ...configured,
          definition: {
            ...configured.definition,
            headers: { ...configured.definition.headers, Authorization: "fixture-static-secret" },
          },
        };
        const sdk = yield* makeMcpSdkAuth;
        const ui = yield* browser("manual");
        const grant = yield* sdk.login(server, {
          ...ui,
          openBrowser: (url) =>
            Effect.sync(() => {
              expect(new URL(url).searchParams.get("scope")).toBe("tools");
            }).pipe(Effect.andThen(ui.openBrowser(url))),
        });
        expect(grant.resourceMetadataSource).toBeUndefined();
        const stored = yield* restore(yield* persist(grant));
        const restored = yield* makeMcpSdkAuth;
        expect(yield* restored.token(server, stored)).toBe("fixture-access-0");
        expect(yield* restored.token(server, yield* restored.refresh(server, stored))).toBe(
          "fixture-access-1",
        );
        expect(
          fixture.requests.some((request) =>
            request.path.startsWith("/.well-known/oauth-protected-resource"),
          ),
        ).toBe(false);
        expect(
          fixture.requests
            .filter((request) => request.path === "/mcp")
            .map((request) => request.method),
        ).toEqual(["GET"]);
        expect(
          fixture.requests.every(
            (request) => !request.headers.authorization && !request.headers["x-resource-secret"],
          ),
        ).toBe(true);
        expect(fixture.counts()).toEqual({ registered: 0, exchanged: 1, refreshed: 1 });
      }).pipe(Effect.provide(layers)),
  );

  it.live(
    "registers a native public client and discards surplus secrets through login, restore and refresh",
    () =>
      Effect.gen(function* () {
        const fixture = yield* startOAuthServer({
          secretClient: true,
          requireNativeClient: true,
          tokenAuthMethods: ["none", "client_secret_basic", "client_secret_post"],
        });
        const server = fixture.configured("dynamic");
        const sdk = yield* makeMcpSdkAuth;
        const grant = yield* sdk.login(server, yield* browser("manual"));
        const encoded = yield* persist(grant);
        expect(encoded).not.toContain("fixture-unused-secret");
        expect(grant.clientInformation).not.toHaveProperty("client_secret");
        expect(grant.clientInformation).not.toHaveProperty("client_secret_expires_at");
        expect(grant.clientInformation).toHaveProperty("token_endpoint_auth_method", "none");
        const stored = yield* restore(encoded);
        const restored = yield* makeMcpSdkAuth;
        expect(yield* restored.token(server, stored)).toBe("fixture-access-0");
        // A stored declaration must survive decoding, not become public through SDK field stripping.
        for (const method of ["client_secret_post", "private_key_jwt"]) {
          const changed = {
            ...stored,
            clientInformation: { client_id: stored.clientId, token_endpoint_auth_method: method },
          };
          expect(yield* restored.token(server, changed).pipe(Effect.flip)).toMatchObject({
            reason: "oauth-client-auth-method-unsupported",
          });
          expect(yield* restored.refresh(server, changed).pipe(Effect.flip)).toMatchObject({
            reason: "oauth-client-auth-method-unsupported",
          });
        }
        // Rehydrate a compatible surplus-secret record; refreshed storage must be sanitized too.
        const surplus = {
          ...stored,
          clientInformation: {
            client_id: stored.clientId,
            token_endpoint_auth_method: "none",
            client_secret: "private-restored-unused-secret",
            client_secret_expires_at: 0,
          },
        };
        const refreshed = yield* restored.refresh(server, surplus);
        expect(yield* restored.token(server, refreshed)).toBe("fixture-access-1");
        expect(yield* persist(refreshed)).not.toContain("private-restored-unused-secret");
        expect(refreshed.clientInformation).not.toHaveProperty("client_secret");
        expect(refreshed.clientInformation).not.toHaveProperty("client_secret_expires_at");
        expect(refreshed.clientInformation).toHaveProperty("token_endpoint_auth_method", "none");
        expect(fixture.counts()).toEqual({ registered: 1, exchanged: 1, refreshed: 1 });
      }).pipe(Effect.provide(layers)),
  );

  for (const issuerRootSlash of [false, true])
    it.live(
      `restores and refreshes endpoint-origin fallback grants, root slash=${issuerRootSlash}`,
      () =>
        Effect.gen(function* () {
          const fixture = yield* startOAuthServer({
            resourceMetadataStatuses: [404],
            issuerRootSlash,
          });
          const configured = fixture.configured("dynamic");
          if (
            configured.definition?.transport !== "http" ||
            configured.definition.auth.type !== "oauth"
          )
            return yield* Effect.die("Missing OAuth fixture.");
          const definition = configured.definition;
          const auth = {
            type: "oauth" as const,
            registration: "dynamic" as const,
            scopes: [],
            redirectUri: configured.definition.auth.redirectUri!,
          };
          const server = { ...configured, definition: { ...definition, auth } };
          const sdk = yield* makeMcpSdkAuth;
          const grant = yield* sdk.login(server, yield* browser("manual"));
          expect(grant.resourceMetadataSource).toBe("origin");
          expect(grant.issuer).toBe(fixture.issuer);
          const stored = yield* restore(yield* persist(grant));
          const restored = yield* makeMcpSdkAuth;
          expect(yield* restored.token(server, stored)).toBe("fixture-access-0");
          const refreshed = yield* restored.refresh(server, stored);
          expect(refreshed.resourceMetadataSource).toBe("origin");
          expect(yield* restored.token(server, refreshed)).toBe("fixture-access-1");
          for (const changedDefinition of [
            { ...definition, auth: { ...auth, allowMissingResourceMetadata: false } },
            { ...definition, auth: { ...auth, issuer: "https://other.example" } },
            { ...definition, url: "https://other.example/mcp", auth },
            { ...definition, auth: { ...auth, resource: `${fixture.origin}/other` } },
          ]) {
            const changed = { ...server, definition: changedDefinition };
            expect((yield* restored.token(changed, refreshed).pipe(Effect.result))._tag).toBe(
              "Failure",
            );
            expect((yield* restored.refresh(changed, refreshed).pipe(Effect.result))._tag).toBe(
              "Failure",
            );
          }
          expect(fixture.counts()).toEqual({ registered: 1, exchanged: 1, refreshed: 1 });
        }).pipe(Effect.provide(layers)),
    );

  for (const status of [404, 410, 401, 403, 429, 502])
    it.live(`authorization-server fallback requires absence, not rejection: ${status}`, () =>
      Effect.gen(function* () {
        const fixture = yield* startOAuthServer({ authorizationMetadataStatuses: [status, 200] });
        const sdk = yield* makeMcpSdkAuth;
        const absent = status === 404 || status === 410;
        expect(
          yield* sdk
            .login(fixture.configured("dynamic"), yield* browser("manual"))
            .pipe(Effect.isSuccess),
        ).toBe(absent);
        if (absent) expect(fixture.counts()).toEqual({ registered: 1, exchanged: 1, refreshed: 0 });
        else {
          expect(fixture.counts()).toEqual({ registered: 0, exchanged: 0, refreshed: 0 });
          expect(fixture.requests.some((request) => request.path.includes("openid"))).toBe(false);
        }
      }).pipe(Effect.provide(layers)),
    );

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
          if (configured.definition?.transport !== "http")
            return yield* Effect.die("Fixture OAuth definition missing.");
          const server = fixture.configured("dynamic", { allowMissingResourceMetadata: true });
          const grant = yield* sdk.login(server, yield* browser("manual"));
          expect(grant.resourceMetadataSource).toBe("configured");
          const stored = yield* restore(yield* persist(grant));
          const restored = yield* makeMcpSdkAuth;
          expect(yield* restored.token(server, stored)).toBe("fixture-access-0");
          const refreshed = yield* restored.refresh(server, stored);
          expect(refreshed.resourceMetadataSource).toBe("configured");
          expect(yield* restored.token(server, refreshed)).toBe("fixture-access-1");
          expect(fixture.counts()).toEqual({ registered: 1, exchanged: 1, refreshed: 1 });
          // Keep identity unchanged here to exercise restore policy independently of config hashing.
          expect(yield* restored.token(configured, refreshed)).toBe("fixture-access-1");
          const allow = { allowMissingResourceMetadata: true };
          for (const changed of [
            fixture.configured("dynamic", { allowMissingResourceMetadata: false }),
            fixture.configured("dynamic", { ...allow, issuer: `${fixture.issuer}/other` }),
            fixture.configured("dynamic", { ...allow, resource: `${fixture.origin}/other` }),
            {
              ...configured,
              definition: {
                ...configured.definition,
                auth: {
                  type: "oauth" as const,
                  registration: "dynamic" as const,
                  scopes: [],
                  ...allow,
                },
              },
            },
          ]) {
            expect(yield* restored.token(changed, refreshed).pipe(Effect.isFailure)).toBe(true);
            expect(yield* restored.refresh(changed, refreshed).pipe(Effect.isFailure)).toBe(true);
          }
          expect(fixture.counts().refreshed).toBe(1);
        }).pipe(Effect.provide(layers)),
    );
  }

  for (const options of [
    { resourceMismatch: true },
    { issuerMismatch: true, resourceMetadataStatuses: [404] },
    { unsupportedPkce: true, resourceMetadataStatuses: [404] },
    { secretClient: true, clientAuthMethod: "client_secret_post", resourceMetadataStatuses: [404] },
  ]) {
    it.live(
      `compatibility does not relax OAuth binding or client policy: ${JSON.stringify(options)}`,
      () =>
        Effect.gen(function* () {
          const fixture = yield* startOAuthServer(options);
          const sdk = yield* makeMcpSdkAuth;
          const server = fixture.configured("dynamic", { allowMissingResourceMetadata: true });
          const result = yield* sdk.login(server, yield* browser("manual")).pipe(Effect.result);
          expect(result._tag).toBe("Failure");
          expect(fixture.counts().exchanged).toBe(0);
          expect(yield* serialize(result)).not.toContain("fixture-unused-secret");
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
        const server = fixture.configured("pre-registered", {
          allowMissingResourceMetadata: true,
        });
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
    { secretClient: true, clientAuthMethod: "client_secret_post" },
    { secretClient: true, clientAuthMethod: null },
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
        if ("secretClient" in options) {
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: {
              reason:
                options.clientAuthMethod === null
                  ? "oauth-client-auth-method-ambiguous"
                  : "oauth-client-auth-method-unsupported",
            },
          });
          expect(
            fixture.requests.some(
              (request) => request.path === "/authorize" || request.path === "/token",
            ),
          ).toBe(false);
        }
        expect(fixture.requests.some((request) => request.path === "/token-replay")).toBe(false);
      }).pipe(Effect.provide(layers)),
    );
  }
  it.live("closes a local callback listener when login is interrupted before callback", () =>
    Effect.gen(function* () {
      const fixture = yield* startOAuthServer();
      const sdk = yield* makeMcpSdkAuth;
      const opened = yield* Deferred.make<string>();
      const server = fixture.configured("pre-registered", {
        redirectUri: "http://127.0.0.1:0/callback",
      });
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
      expect(yield* client.get(redirect).pipe(Effect.isFailure)).toBe(true);
      expect(fixture.counts().exchanged).toBe(0);
    }).pipe(Effect.provide(layers)),
  );
  it.effect(
    "returns only probe headers and closes a nonending SSE body before the auth scope ends",
    () =>
      Effect.gen(function* () {
        const closed = yield* Deferred.make<void>();
        const nextEntered = yield* Deferred.make<void>();
        const nextRelease = yield* Deferred.make<void>();
        let visits = 0;
        const fixture = yield* startHttpServer(() =>
          ++visits > 1
            ? Deferred.succeed(nextEntered, undefined).pipe(
                Effect.andThen(Deferred.await(nextRelease)),
                Effect.as(HttpServerResponse.empty()),
              )
            : Effect.succeed(
                HttpServerResponse.stream(
                  Stream.make(new TextEncoder().encode(": keepalive\n\n")).pipe(
                    Stream.concat(Stream.never),
                    Stream.ensuring(Deferred.succeed(closed, undefined)),
                  ),
                  {
                    status: 401,
                    contentType: "text/event-stream",
                    headers: { "www-authenticate": "Bearer realm=fixture" },
                  },
                ),
              ),
        );
        const origin = fixture.url.origin;
        const policy = { privateOrigins: new Set([origin]), localHttpOrigins: new Set([origin]) };
        let response: Response | undefined;
        const scope = yield* withAuthFetch(policy, (fetch, probe) =>
          probe(fixture.url).then((headers) => {
            response = headers;
            return fetch(fixture.url);
          }),
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(nextEntered);
        expect(response?.status).toBe(401);
        expect(response?.body).toBeNull();
        // The next request holds the auth scope open while native SSE cleanup settles.
        yield* Deferred.await(closed);
        yield* Deferred.succeed(nextRelease, undefined);
        yield* Fiber.join(scope);
      }).pipe(Effect.provide(layers)),
  );

  for (const [kind, mode] of ["fetch", "probe"].flatMap((kind) =>
    ["interrupt", "deadline", "signal"].map((mode) => [kind, mode] as const),
  )) {
    it.effect(`cancels an owned ${kind} on ${mode} and joins remote request cleanup`, () =>
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
        const controller = new AbortController();
        const request = yield* withAuthFetch(policy, (fetch, probe) =>
          kind === "probe"
            ? probe(fixture.url, controller.signal)
            : fetch(fixture.url, { signal: controller.signal }),
        ).pipe(Effect.result, Effect.forkScoped);
        yield* Deferred.await(entered);
        if (mode === "interrupt") yield* Fiber.interrupt(request);
        else {
          if (mode === "deadline") yield* TestClock.adjust(15_000);
          else controller.abort();
          const result = yield* Fiber.join(request);
          expect(result._tag === "Failure" && result.failure.kind).toBe(
            mode === "deadline" ? "timeout" : "cancelled",
          );
        }
        yield* Deferred.await(closed);
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      }).pipe(Effect.provide(layers)),
    );
  }
  it.live("keeps callback URLs and OAuth requests out of ambient HTTP tracing", () => {
    const trace = makeCapturedTracer();
    return Effect.gen(function* () {
      const fixture = yield* startOAuthServer({ secretClient: true }).pipe(
        Effect.provideService(HttpMiddleware.TracerDisabledWhen, () => true),
      );
      const sdk = yield* makeMcpSdkAuth;
      const server = fixture.configured("dynamic", { redirectUri: "http://127.0.0.1:0/callback" });
      const grant = yield* sdk.login(server, yield* browser("local"));
      yield* sdk.refresh(server, grant);
      const snapshot = capturedTelemetrySnapshot(trace);
      expect(snapshot).not.toMatch(
        /127\.0\.0\.1|fixture-code|fixture-access|fixture-refresh|fixture-unused-secret|state=/,
      );
    }).pipe(Effect.provide(Layer.merge(layers, trace.layer)));
  });
  it.live("rechecks authority after DNS before sending a refresh credential", () =>
    Effect.gen(function* () {
      let current = true;
      let received = 0;
      const fixture = yield* startHttpServer(() =>
        Effect.sync(() => {
          received++;
          return HttpServerResponse.empty();
        }),
      );
      const origin = fixture.url.origin;
      const check = Effect.suspend(() =>
        current ? Effect.void : Effect.fail(boundaryError("stale", "not-sent", "Revoked")),
      );
      const result = yield* withAuthFetch(
        { privateOrigins: new Set([origin]), localHttpOrigins: new Set([origin]) },
        (fetch) => fetch(fixture.url, { method: "POST", body: "refresh_token=private" }),
      ).pipe(
        Effect.provideService(AuthRequestCurrent, check),
        Effect.provideService(NetworkAddresses, {
          resolve: () =>
            Effect.sync(() => {
              current = false;
              return [{ address: "127.0.0.1", family: 4 as const }];
            }),
        }),
        Effect.flip,
      );
      expect(result.kind).toBe("stale");
      expect(received).toBe(0);
    }).pipe(Effect.provide(layers)),
  );

  it.live("does not let SDK fallback swallow a denied request", () =>
    Effect.gen(function* () {
      const fixture = yield* startOAuthServer();
      const policy = yield* authUrlPolicy(fixture.configured("pre-registered"));
      const denied = withAuthFetch(policy, (fetch) =>
        fetch("http://169.254.169.254/metadata").then(
          () => "fallback",
          () => "fallback",
        ),
      );
      expect(yield* Effect.isFailure(denied)).toBe(true);
    }).pipe(Effect.provide(layers)),
  );
});
