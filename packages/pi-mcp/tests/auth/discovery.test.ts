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

  for (const mode of ["default", "issuer-only", "opt-in-without-issuer"] as const)
    it.live(`keeps missing metadata blocked for ${mode}`, () =>
      Effect.gen(function* () {
        const fixture = yield* startOAuthServer({ resourceMetadataStatuses: [404] });
        let config: McpOAuthConfig = { type: "oauth", registration: "dynamic", scopes: [] };
        if (mode === "issuer-only") config = { ...config, issuer: fixture.issuer };
        if (mode === "opt-in-without-issuer")
          config = { ...config, allowMissingResourceMetadata: true };
        const result = yield* discover(fixture.origin, config).pipe(Effect.result);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { kind: "unsupported", reason: "oauth-resource-metadata-missing" },
        });
        if (result._tag === "Failure") {
          const reply = mcpFailureReply("command", result.failure);
          expect(reply.data).toMatchObject({ reason: "oauth-resource-metadata-missing" });
          expect(yield* serialize(reply)).not.toContain("fixture-private");
        }
      }).pipe(Effect.provide(network)),
    );

  const failures: ReadonlyArray<OAuthFixtureOptions> = [
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

  for (const statuses of [[200], [404, 200]])
    it.live(`retains real metadata instead of replacing its bindings: ${statuses}`, () =>
      Effect.gen(function* () {
        const fixture = yield* startOAuthServer({
          resourceMismatch: true,
          resourceMetadataStatuses: statuses,
        });
        const result = yield* discover(fixture.origin);
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
            ++lookups === 1
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
              ++lookups === 1
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
