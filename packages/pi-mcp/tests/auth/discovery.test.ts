import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { NetworkAddressError, NetworkAddresses } from "pi-cosmic-core";
import { describe, expect } from "vitest";
import { discoverAuthResource } from "../../src/boundary/sdk-auth-discovery.ts";
import { mcpFailureReply } from "../../src/boundary/host-tool-result.ts";
import type { McpOAuthConfig } from "../../src/config/model.ts";
import { startOAuthServer, type OAuthFixtureOptions } from "../fixtures/oauth-server.ts";

const serialize = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const network = Layer.succeed(NetworkAddresses, {
  resolve: () => Effect.succeed([{ address: "127.0.0.1", family: 4 as const }]),
});
const discover = (
  origin: string,
  config: McpOAuthConfig = {
    type: "oauth",
    registration: "dynamic",
    scopes: [],
    issuer: origin,
    allowMissingResourceMetadata: true,
  },
  root = false,
) =>
  discoverAuthResource(root ? origin : `${origin}/mcp`, new URL(`${origin}/mcp`), config, {
    privateOrigins: new Set([origin]),
    localHttpOrigins: new Set([origin]),
  });

describe("protected-resource challenge discovery", () => {
  for (const parameter of [
    (origin: string) => `Bearer resource_metadata="${origin}/oauth/resource"`,
    (origin: string) => `bearer Resource_Metadata = "${origin}/oauth/resource"`,
    (origin: string) =>
      `Bearer resource_metadata-extra="ignored", resource_metadata="${origin}/oauth/resource"`,
    (origin: string) =>
      `Basic realm="fixture", Bearer resource_metadata="${origin}/oauth/resource"`,
    (origin: string) =>
      `Basic resource_metadata="http://169.254.169.254/metadata", Bearer resource_metadata="${origin}/oauth/resource"`,
    (origin: string) =>
      `Bearer resource_metadata="${origin}/oauth/resource", Basic resource_metadata="http://169.254.169.254/metadata"`,
    (origin: string) =>
      `Bearer realm="resource_metadata=ignored", resource_metadata="${origin}/oauth/resource", error_description="resource_metadata=also-ignored"`,
  ])
    it.live("uses advertised metadata when guessed well-known paths are absent", () =>
      Effect.gen(function* () {
        const fixture = yield* startOAuthServer({
          resourceChallenge: parameter,
          resourceMetadataStatuses: [404],
        });
        const result = yield* discover(fixture.origin, {
          type: "oauth",
          registration: "dynamic",
          scopes: [],
        });
        expect(result.source).toBeUndefined();
        expect(result.metadata.resource).toBe(fixture.resource);
        expect(fixture.requests.map((request) => request.path)).toEqual([
          "/mcp",
          "/oauth/resource",
        ]);
        expect(fixture.requests.every((request) => request.method === "GET")).toBe(true);
        expect(
          fixture.requests.every(
            (request) => !request.headers.authorization && !request.headers["x-resource-secret"],
          ),
        ).toBe(true);
      }).pipe(Effect.provide(network)),
    );

  for (const status of [401, 404, 405])
    it.live(`keeps no-hint fallback and compatibility after probe ${status}`, () =>
      Effect.gen(function* () {
        for (const metadataStatus of [200, 404]) {
          const fixture = yield* startOAuthServer({
            resourceProbeStatus: status,
            resourceChallenge: () => 'Bearer realm="resource_metadata=not-a-hint"',
            resourceMetadataStatuses: [metadataStatus],
          });
          const result = yield* discover(fixture.origin);
          expect(result.metadata.resource).toBe(fixture.resource);
          expect(result.source).toBe(metadataStatus === 404 ? "configured" : undefined);
        }
      }).pipe(Effect.provide(network)),
    );

  for (const header of [
    'Bearer resource_metadata="/relative"',
    'Bearer resource_metadata=""',
    "Bearer resource_metadata=",
    'Bearer resource_metadata="https://public.example/unclosed',
    'Bearer resource_metadata="https://public.example/metadata"junk',
    'Bearer resource_metadata="http://169.254.169.254/metadata"',
    'Bearer resource_metadata="https://private.example/metadata"',
    'Bearer resource_metadata="https://user:secret@public.example/metadata"',
    'Bearer resource_metadata="https://public.example/metadata#fragment"',
    'Bearer resource_metadata="https://public.example/white space"',
    'Bearer resource_metadata="https://public.example/back\\\\slash"',
    'Bearer resource_metadata="https://public.example/a", resource_metadata="https://public.example/b"',
  ])
    it.live(`rejects unsafe or malformed advertised hints: ${header}`, () =>
      Effect.gen(function* () {
        const fixture = yield* startOAuthServer({ resourceChallenge: () => header });
        const result = yield* discover(fixture.origin).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(fixture.requests.map((request) => request.path)).toEqual(["/mcp"]);
        expect(yield* serialize(result)).not.toContain("user:secret");
        expect(fixture.counts()).toEqual({ registered: 0, exchanged: 0, refreshed: 0 });
      }).pipe(Effect.provide(network)),
    );

  it.live("does not use another authentication scheme's metadata parameter", () =>
    Effect.gen(function* () {
      const fixture = yield* startOAuthServer({
        resourceChallenge: (origin) =>
          `Bearer realm="fixture", Basic resource_metadata="${origin}/oauth/resource"`,
      });
      const result = yield* discover(fixture.origin);
      expect(result.metadata.resource).toBe(fixture.resource);
      expect(fixture.requests.some((request) => request.path === "/oauth/resource")).toBe(false);
      expect(
        fixture.requests.some((request) =>
          request.path.startsWith("/.well-known/oauth-protected-resource"),
        ),
      ).toBe(true);
    }).pipe(Effect.provide(network)),
  );

  for (const status of [401, 500])
    it.live(`does not replace a failed advertised URL with guessed metadata: ${status}`, () =>
      Effect.gen(function* () {
        const fixture = yield* startOAuthServer({
          resourceChallenge: (origin) => `Bearer resource_metadata="${origin}/oauth/resource"`,
          challengeMetadataStatus: status,
        });
        const result = yield* discover(fixture.origin, {
          type: "oauth",
          registration: "dynamic",
          scopes: [],
        }).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(fixture.requests.map((request) => request.path)).toEqual([
          "/mcp",
          "/oauth/resource",
        ]);
      }).pipe(Effect.provide(network)),
    );
});

describe("protected-resource discovery compatibility", () => {
  for (const statuses of [
    [404, 404],
    [404, 410],
    [410, 404],
  ])
    it.live(`accepts only explicit absence with configured bindings: ${statuses}`, () =>
      Effect.gen(function* () {
        const fixture = yield* startOAuthServer({ resourceMetadataStatuses: statuses });
        const result = yield* discover(fixture.origin);
        expect(result).toMatchObject({
          source: "configured",
          metadata: { resource: fixture.resource, authorization_servers: [fixture.issuer] },
        });
        expect(fixture.counts()).toEqual({ registered: 0, exchanged: 0, refreshed: 0 });
      }).pipe(Effect.provide(network)),
    );

  it.live("supports a root endpoint without requiring a path fallback", () =>
    Effect.gen(function* () {
      const fixture = yield* startOAuthServer({ resourceMetadataStatuses: [404] });
      expect((yield* discover(fixture.origin, undefined, true)).source).toBe("configured");
    }).pipe(Effect.provide(network)),
  );

  for (const mode of ["default", "issuer-only", "opt-in-without-issuer", "strict"] as const)
    it.live(`applies missing metadata policy for ${mode}`, () =>
      Effect.gen(function* () {
        const fixture = yield* startOAuthServer({ resourceMetadataStatuses: [404] });
        let config: McpOAuthConfig = { type: "oauth", registration: "dynamic", scopes: [] };
        if (mode === "issuer-only") config = { ...config, issuer: fixture.issuer };
        if (mode === "opt-in-without-issuer")
          config = { ...config, allowMissingResourceMetadata: true };
        if (mode === "strict") config = { ...config, allowMissingResourceMetadata: false };
        const result = yield* discover(fixture.origin, config).pipe(Effect.result);
        if (mode === "strict")
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: { kind: "unsupported", reason: "oauth-resource-metadata-missing" },
          });
        else
          expect(result).toMatchObject({
            _tag: "Success",
            success: {
              source: mode === "issuer-only" ? "configured" : "origin",
              metadata: { resource: fixture.resource, authorization_servers: [fixture.origin] },
            },
          });
        if (result._tag === "Failure") {
          const reply = mcpFailureReply("command", result.failure);
          expect(reply.data).toMatchObject({ reason: "oauth-resource-metadata-missing" });
          expect(yield* serialize(reply)).not.toContain("fixture-private");
        }
      }).pipe(Effect.provide(network)),
    );

  const failures: ReadonlyArray<OAuthFixtureOptions> = [
    { resourceMetadataStatuses: [401, 200] },
    { resourceMetadataStatuses: [403, 200] },
    { resourceMetadataStatuses: [429, 200] },
    { resourceMetadataStatuses: [502, 200] },
    { resourceMetadataStatuses: [401, 404] },
    { resourceMetadataStatuses: [403, 404] },
    { resourceMetadataStatuses: [429, 404] },
    { resourceMetadataStatuses: [502, 404] },
    { resourceMetadataStatuses: [500] },
    { invalidResourceMetadata: "json" },
    { invalidResourceMetadata: "schema" },
    { oversizedResourceMetadata: true },
    { resourceMetadataRedirect: "private" },
    { resourceMetadataRedirect: "loop" },
  ];
  for (const options of failures)
    it.live(`never falls back after rejected discovery: ${JSON.stringify(options)}`, () =>
      Effect.gen(function* () {
        const fixture = yield* startOAuthServer(options);
        const result = yield* discover(fixture.origin).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(yield* serialize(result)).not.toContain("fixture-private");
        expect(fixture.counts()).toEqual({ registered: 0, exchanged: 0, refreshed: 0 });
      }).pipe(Effect.provide(network)),
    );

  it.live(
    "derives a missing-metadata issuer from the endpoint, not a resource override or hint",
    () =>
      Effect.gen(function* () {
        const fixture = yield* startOAuthServer({
          resourceMetadataStatuses: [404],
          resourceChallenge: (origin) => `Bearer resource_metadata="${origin}/oauth/resource"`,
          challengeMetadataStatus: 410,
        });
        const result = yield* discoverAuthResource(
          `${fixture.origin}/mcp?tenant=fixture`,
          new URL("https://other.example/resource"),
          {
            type: "oauth",
            registration: "dynamic",
            scopes: [],
            resource: "https://other.example/resource",
          },
          {
            privateOrigins: new Set([fixture.origin]),
            localHttpOrigins: new Set([fixture.origin]),
          },
        );
        expect(result).toMatchObject({
          source: "origin",
          metadata: {
            resource: "https://other.example/resource",
            authorization_servers: [fixture.origin],
          },
        });
        expect(fixture.requests.some((request) => request.path.startsWith("/.well-known/"))).toBe(
          false,
        );
      }).pipe(Effect.provide(network)),
  );

  for (const allowMissingResourceMetadata of [false, true])
    for (const statuses of [[200], [404, 200]])
      it.live(
        `retains real metadata bindings: ${statuses}, compatibility=${allowMissingResourceMetadata}`,
        () =>
          Effect.gen(function* () {
            const fixture = yield* startOAuthServer({
              resourceMismatch: true,
              resourceMetadataStatuses: statuses,
            });
            const result = yield* discover(fixture.origin, {
              type: "oauth",
              registration: "dynamic",
              scopes: [],
              allowMissingResourceMetadata,
            });
            expect(result.source).toBeUndefined();
            // Login, not discovery, rejects this binding. Compatibility must not replace it.
            expect(result.metadata.resource).not.toBe(fixture.resource);
          }).pipe(Effect.provide(network)),
      );

  it.live("does not reinterpret a network failure following a missing response as absence", () =>
    Effect.gen(function* () {
      const fixture = yield* startOAuthServer({ resourceMetadataStatuses: [404] });
      let lookups = 0;
      const result = yield* discover(fixture.origin).pipe(
        Effect.result,
        Effect.provideService(NetworkAddresses, {
          resolve: () =>
            ++lookups <= 2
              ? Effect.succeed([{ address: "127.0.0.1", family: 4 as const }])
              : Effect.fail(new NetworkAddressError({ message: "fixture-private-network" })),
        }),
      );
      expect(result).toMatchObject({ _tag: "Failure", failure: { kind: "unavailable" } });
      expect(yield* serialize(result)).not.toContain("fixture-private");
    }),
  );

  for (const mode of ["deadline", "interrupt"] as const)
    it.effect(`does not fall back when discovery is stopped by ${mode}`, () =>
      Effect.gen(function* () {
        const fixture = yield* startOAuthServer({ resourceMetadataStatuses: [404] });
        const entered = yield* Deferred.make<void>();
        const released = yield* Deferred.make<void>();
        let lookups = 0;
        const fiber = yield* discover(fixture.origin).pipe(
          Effect.result,
          Effect.provideService(NetworkAddresses, {
            resolve: () =>
              ++lookups <= 2
                ? Effect.succeed([{ address: "127.0.0.1", family: 4 as const }])
                : Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Effect.never),
                    Effect.ensuring(Deferred.succeed(released, undefined)),
                  ),
          }),
          Effect.forkChild,
        );
        yield* Deferred.await(entered);
        if (mode === "deadline") {
          yield* TestClock.adjust(15_000);
          expect(yield* Fiber.join(fiber)).toMatchObject({
            _tag: "Failure",
            failure: { kind: "timeout" },
          });
        } else yield* Fiber.interrupt(fiber);
        yield* Deferred.await(released);
        expect(fixture.counts()).toEqual({ registered: 0, exchanged: 0, refreshed: 0 });
      }),
    );
});
