import { it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vitest";
import {
  approveScopes,
  parseScopes,
  proposeScopes,
  validateAuthorizationScopes,
  validateScopes,
} from "../../src/auth/scopes.ts";
import { parseBearerChallenge } from "../../src/boundary/sdk-auth-challenge.ts";
import type { McpOAuthConfig } from "../../src/config/model.ts";
import { manualUi as ui } from "../fixtures/auth.ts";
import { blockingProbe } from "../fixtures/probes.ts";
const config: McpOAuthConfig = { type: "oauth", registration: "dynamic", scopes: [] };

describe("OAuth permission policy", () => {
  for (const value of [" ", "read write", "a\t", "a\n", "a\0", 'a"b', "a\\b", "é", "a".repeat(257)])
    it.effect("rejects malformed scope tokens without repairing their spelling", () =>
      Effect.gen(function* () {
        expect(yield* validateScopes([value]).pipe(Effect.isFailure)).toBe(true);
      }),
    );
  it.effect("keeps case and requires single ASCII spaces between wire tokens", () =>
    Effect.gen(function* () {
      expect(yield* parseScopes("Read read")).toEqual(["Read", "read"]);
      for (const value of [" read", "read ", "read  write", "read\twrite"])
        expect(yield* parseScopes(value).pipe(Effect.isFailure)).toBe(true);
    }),
  );
  it.effect(
    "selects challenge then resource permissions, never the authorization server catalog",
    () =>
      Effect.gen(function* () {
        expect(
          yield* proposeScopes(config, {
            retained: true,
            challenge: { scope: "read" },
            resourceScopes: ["write"],
            serverScopes: ["admin"],
          }),
        ).toEqual({ requested: ["read"], additions: ["read"], source: "challenge" });
        expect(
          (yield* proposeScopes(config, {
            retained: false,
            resourceScopes: ["read"],
            serverScopes: ["admin"],
          })).requested,
        ).toEqual(["read"]);
        expect(
          (yield* proposeScopes(config, {
            retained: false,
            serverScopes: ["admin", "offline_access"],
          })).requested,
        ).toEqual([]);
      }),
  );
  it.effect(
    "preserves configured permissions unless a retained insufficient-scope rejection proposes additions",
    () =>
      Effect.gen(function* () {
        const configured = { ...config, scopes: ["read"] };
        for (const retained of [false, true])
          for (const error of ["invalid_token", "insufficient_scope"]) {
            const proposal = yield* proposeScopes(configured, {
              retained,
              challenge: { scope: "write", error },
              resourceScopes: ["admin"],
            });
            expect(proposal.requested).toEqual(
              retained && error === "insufficient_scope" ? ["read", "write"] : ["read"],
            );
          }
      }),
  );
  it.effect("explicit empty scopes suppress inference and conditional offline access", () =>
    Effect.gen(function* () {
      expect(
        (yield* proposeScopes(
          { ...config, explicitEmptyScopes: true },
          {
            retained: true,
            challenge: { scope: "read", error: "insufficient_scope" },
            resourceScopes: ["write"],
            serverScopes: ["offline_access"],
          },
        )).requested,
      ).toEqual([]);
    }),
  );
  it.effect("does not apply the request budget to an unrelated authorization server catalog", () =>
    Effect.gen(function* () {
      const catalog = Array.from({ length: 1000 }, (_, index) => `unrelated_permission_${index}`);
      catalog.push("offline_access");
      expect(
        (yield* proposeScopes(
          { ...config, scopes: ["read"] },
          { retained: false, serverScopes: catalog },
        )).requested,
      ).toEqual(["offline_access", "read"]);
    }),
  );
  it.effect(
    "adds advertised offline access only with nonempty permissions and permitted refresh",
    () =>
      Effect.gen(function* () {
        const configured = { ...config, scopes: ["read"] };
        expect(
          yield* proposeScopes(configured, {
            retained: false,
            serverScopes: ["offline_access", "admin"],
          }),
        ).toEqual({
          requested: ["offline_access", "read"],
          additions: ["offline_access"],
          source: "configured",
        });
        expect(
          (yield* proposeScopes(configured, {
            retained: false,
            serverScopes: ["offline_access"],
            grantTypes: ["authorization_code"],
          })).requested,
        ).toEqual(["read"]);
      }),
  );
  it.effect(
    "fails closed without consent, and on decline, cancellation, or an expired deadline",
    () =>
      Effect.gen(function* () {
        const proposal = yield* proposeScopes(config, {
          retained: false,
          resourceScopes: ["read"],
        });
        const deadline = (yield* Clock.currentTimeMillis) + 1000;
        expect(yield* approveScopes(ui, proposal, deadline).pipe(Effect.flip)).toMatchObject({
          reason: "oauth-scope-approval-required",
        });
        expect(
          yield* approveScopes(
            { ...ui, approveScopes: () => Effect.succeed(false) },
            proposal,
            deadline,
          ).pipe(Effect.flip),
        ).toMatchObject({ kind: "cancelled" });
        let called = false;
        expect(
          yield* approveScopes(
            {
              ...ui,
              approveScopes: () =>
                Effect.sync(() => {
                  called = true;
                  return true;
                }),
            },
            proposal,
            0,
          ).pipe(Effect.flip),
        ).toMatchObject({ kind: "timeout" });
        expect(called).toBe(false);
        const approval = yield* blockingProbe;
        const pending = yield* approveScopes(
          { ...ui, approveScopes: () => approval.block },
          proposal,
          deadline,
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(approval.entered);
        yield* Fiber.interrupt(pending);
        expect(approval.released()).toBe(true);
      }),
  );
  it.effect("owns the deadline even when consent does not settle", () =>
    Effect.gen(function* () {
      const proposal = yield* proposeScopes(config, { retained: false, resourceScopes: ["read"] });
      const entered = yield* Deferred.make<void>();
      const pending = yield* approveScopes(
        {
          ...ui,
          approveScopes: () =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        },
        proposal,
        (yield* Clock.currentTimeMillis) + 1000,
      ).pipe(Effect.result, Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* TestClock.adjust(1000);
      expect(yield* Fiber.join(pending)).toMatchObject({
        _tag: "Failure",
        failure: { kind: "timeout" },
      });
    }),
  );
  it.effect("rejects injected and duplicated outbound scope parameters", () =>
    Effect.gen(function* () {
      for (const [query, requested] of [
        ["?scope=admin", []],
        ["?scope=read&scope=admin", ["read"]],
        ["?scope=Read", ["read"]],
        ["?scope=read+admin", ["read"]],
      ] as const)
        expect(
          yield* validateAuthorizationScopes(
            new URL(`https://issuer.example/authorize${query}`),
            requested,
          ).pipe(Effect.isFailure),
        ).toBe(true);
      yield* validateAuthorizationScopes(new URL("https://issuer.example/authorize?scope=read"), [
        "read",
      ]);
    }),
  );
});

describe("private Bearer challenge parsing", () => {
  it.effect("retains only fields from the same Bearer challenge", () =>
    Effect.gen(function* () {
      expect(
        yield* parseBearerChallenge(
          'Basic scope="wrong", Bearer scope="Read read", error="insufficient_scope", resource_metadata="https://resource.example/metadata"',
        ),
      ).toEqual({
        scope: "Read read",
        error: "insufficient_scope",
        resourceMetadata: "https://resource.example/metadata",
      });
    }),
  );
  for (const value of [
    'Bearer scope="read", Bearer scope="admin"',
    'Bearer scope="read", scope="write"',
    'Bearer error="invalid_token", ERROR="insufficient_scope"',
    'Bearer scope="read  write"',
    'Bearer scope=""',
    'Bearer scope="read',
    'Bearer scope="read",',
    'Bearer resource_metadata="a", resource_metadata="b"',
    'Bearer scope="é"',
    'Bearer realm="' + "x".repeat(8192) + '"',
  ])
    it.effect("rejects ambiguous, malformed, and oversized challenges", () =>
      Effect.gen(function* () {
        expect(yield* parseBearerChallenge(value).pipe(Effect.isFailure)).toBe(true);
      }),
    );
});
