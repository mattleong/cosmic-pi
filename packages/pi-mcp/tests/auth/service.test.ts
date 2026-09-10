import { it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { describe, expect } from "vitest";
import type { McpGrant } from "../../src/auth/credentials.ts";
import { decodeGrant, encodeGrant } from "../../src/auth/credentials.ts";
import type { McpLoginUi } from "../../src/auth/model.ts";
import { makeMcpAuth } from "../../src/auth/service.ts";
import {
  McpCredentialStore,
  type McpCredentialStoreContract,
} from "../../src/boundary/credential-store.ts";
import { McpSdkAuth, type McpSdkAuthContract } from "../../src/boundary/sdk-auth.ts";
import { boundaryError } from "../../src/client/errors.ts";
import { makeKeychainStore, type KeychainEntryFactory } from "../../src/boundary/keychain.ts";
import type { McpEffectiveServer } from "../../src/config/model.ts";

const server = (digit: string): McpEffectiveServer => ({
  id: "owned",
  identity: digit.repeat(64),
  enabled: true,
  scope: "global",
  directory: "/fixture",
  definition: {
    transport: "http",
    url: "https://resource.example/mcp",
    headers: {},
    denyTools: [],
    auth: { type: "oauth", registration: "pre-registered", clientId: "public", scopes: [] },
  },
});
const grant = (identity: string, expiresAt = 1): McpGrant => ({
  version: 1,
  identity,
  issuer: "https://issuer.example",
  resource: "https://resource.example/mcp",
  clientId: "public",
  registration: "pre-registered",
  redirectUri: "http://127.0.0.1:9000/callback",
  discovery: {},
  resourceMetadata: {},
  clientInformation: {},
  tokens: { access_token: "private-token" },
  receivedAt: 0,
  expiresAt,
});
const ui: McpLoginUi = {
  mode: "manual",
  openBrowser: () => Effect.void,
  readCallback: () => Effect.succeed(undefined),
};
const sdk: McpSdkAuthContract = {
  login: (server) => Effect.succeed(grant(server.identity)),
  refresh: (_server, value) => Effect.succeed(value),
  token: () => Effect.succeed("private-token"),
};
const make = (store: McpCredentialStoreContract, auth: McpSdkAuthContract = sdk) =>
  makeMcpAuth.pipe(
    Effect.provideService(McpCredentialStore, store),
    Effect.provideService(McpSdkAuth, auth),
  );

describe("user-only authentication ownership", () => {
  it.effect("status performs no store, SDK, or environment lookup", () =>
    Effect.gen(function* () {
      const forbidden = Effect.die("status touched a credential boundary");
      const auth = yield* make({
        read: () => forbidden,
        write: () => forbidden,
        remove: () => forbidden,
      });
      expect(yield* auth.status(server("1"))).toEqual({ state: "required" });
      const env: McpEffectiveServer = {
        ...server("1"),
        definition: {
          transport: "http",
          url: "https://resource.example",
          headers: {},
          denyTools: [],
          auth: { type: "env", env: "PI_MCP_MUST_NOT_READ" },
        },
      };
      expect(yield* auth.status(env)).toEqual({ state: "required" });
    }),
  );
  it.effect(
    "rejects unsupported logout without claiming environment credentials were removed",
    () =>
      Effect.gen(function* () {
        const forbidden = Effect.die("unsupported logout touched credentials");
        const auth = yield* make({
          read: () => forbidden,
          write: () => forbidden,
          remove: () => forbidden,
        });
        for (const definition of [
          {
            transport: "http" as const,
            url: "https://resource.example",
            headers: {},
            denyTools: [],
            auth: { type: "env" as const, env: "PI_MCP_ENV_GRANT" },
          },
          {
            transport: "http" as const,
            url: "https://resource.example",
            headers: {},
            denyTools: [],
            auth: { type: "none" as const },
          },
          {
            transport: "stdio" as const,
            command: "owned-fixture",
            args: [],
            environment: {},
            denyTools: [],
          },
        ]) {
          const current = { ...server("9"), definition };
          const token = yield* auth.access(current);
          const status = yield* auth.status(current);
          expect(yield* auth.logout(current).pipe(Effect.flip)).toMatchObject({
            kind: "unsupported",
            outcome: "not-sent",
          });
          expect(yield* auth.access(current)).toBe(token);
          expect(yield* auth.status(current)).toEqual(status);
        }
      }).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord({ PI_MCP_ENV_GRANT: "environment-token" }),
        ),
      ),
  );
  it.effect(
    "serializes refresh before dispatch and all callers observe the durable rotated grant",
    () =>
      Effect.gen(function* () {
        const currentServer = server("2");
        const now = yield* Clock.currentTimeMillis;
        let stored: McpGrant | undefined = grant(currentServer.identity);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let refreshes = 0;
        const store: McpCredentialStoreContract = {
          read: () => Effect.sync(() => stored),
          write: (_identity, value) =>
            Effect.sync(() => {
              stored = value;
            }),
          remove: () =>
            Effect.sync(() => {
              stored = undefined;
            }),
        };
        const auth = yield* make(store, {
          ...sdk,
          refresh: (_server, value) =>
            Effect.gen(function* () {
              refreshes++;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return {
                ...value,
                expiresAt: now + 3_600_000,
                tokens: { access_token: "rotated-token" },
              };
            }),
          token: (_server, value) =>
            Effect.succeed(value.expiresAt === now + 3_600_000 ? "rotated-token" : "old-token"),
        });
        const calls = yield* Effect.all(
          Array.from({ length: 8 }, () => auth.access(currentServer).pipe(Effect.forkScoped)),
        );
        yield* Deferred.await(entered);
        yield* Deferred.succeed(release, undefined);
        const values = yield* Effect.all(calls.map((fiber) => Fiber.join(fiber)));
        expect(values).toEqual(Array(8).fill("rotated-token"));
        expect(refreshes).toBe(1);
        expect(stored?.tokens).toEqual({ access_token: "rotated-token" });
      }),
  );
  it.effect("does not publish a refreshed token when durable storage fails", () =>
    Effect.gen(function* () {
      const currentServer = server("3");
      const auth = yield* make({
        read: () => Effect.succeed(grant(currentServer.identity)),
        write: () => Effect.fail(boundaryError("unavailable", "not-sent", "Store unavailable.")),
        remove: () => Effect.void,
      });
      expect((yield* auth.access(currentServer).pipe(Effect.result))._tag).toBe("Failure");
      expect(yield* auth.status(currentServer)).toEqual({ state: "unavailable" });
    }),
  );
  it.effect(
    "logout cancels an active login before joining persistence and reports failed deletion",
    () =>
      Effect.gen(function* () {
        const currentServer = server("4");
        const entered = yield* Deferred.make<void>();
        let persisted = false;
        const auth = yield* make(
          {
            read: () => Effect.succeed(undefined),
            write: () =>
              Effect.sync(() => {
                persisted = true;
              }),
            remove: () => Effect.fail(boundaryError("cleanup", "not-sent", "Deletion failed.")),
          },
          {
            ...sdk,
            login: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
          },
        );
        const login = yield* auth.login(currentServer, ui).pipe(Effect.result, Effect.forkScoped);
        yield* Deferred.await(entered);
        expect((yield* auth.logout(currentServer).pipe(Effect.result))._tag).toBe("Failure");
        expect((yield* Fiber.join(login))._tag).toBe("Failure");
        expect(persisted).toBe(false);
        expect(yield* auth.status(currentServer)).toEqual({ state: "required" });
      }),
  );
  it.effect("revoke does not wait for ignored native cancellation and permits a later login", () =>
    Effect.gen(function* () {
      const currentServer = server("5");
      const entered = yield* Deferred.make<void>();
      let finish: (value: McpGrant) => void = () => undefined;
      let first = true;
      let stored: McpGrant | undefined;
      const auth = yield* make(
        {
          read: () => Effect.sync(() => stored),
          write: (_identity, value) =>
            Effect.sync(() => {
              stored = value;
            }),
          remove: () => Effect.void,
        },
        {
          ...sdk,
          login: () =>
            Effect.suspend(() => {
              if (!first) return Effect.succeed(grant(currentServer.identity));
              first = false;
              return Effect.tryPromise({
                try: () => {
                  // Native SDK settlement deliberately ignores cancellation for this lifecycle test.
                  const completion = Promise.withResolvers<McpGrant>();
                  finish = completion.resolve;
                  Deferred.doneUnsafe(entered, Effect.void);
                  return completion.promise;
                },
                catch: () => boundaryError("unavailable", "not-sent", "Native failure."),
              });
            }),
        },
      );
      const login = yield* auth.login(currentServer, ui).pipe(Effect.result, Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* auth.revoke;
      expect((yield* Fiber.join(login))._tag).toBe("Failure");
      expect(stored).toBeUndefined();
      expect(yield* auth.login(currentServer, ui)).toEqual({ state: "ready" });
      finish(grant("f".repeat(64)));
      yield* Effect.yieldNow;
      expect(stored?.identity).toBe(currentServer.identity);
    }),
  );
  it.effect(
    "logout joins a cancelled native persistence operation before deleting its late grant",
    () =>
      Effect.gen(function* () {
        const currentServer = server("7");
        const entered = yield* Deferred.make<void>();
        let release: () => void = () => undefined;
        let password: string | undefined;
        let deleted = false;
        const factory: KeychainEntryFactory = () =>
          Promise.resolve({
            getPassword: () => Promise.resolve(password),
            setPassword: (value) => {
              const completion = Promise.withResolvers<void>();
              release = () => {
                password = value;
                completion.resolve();
              };
              Deferred.doneUnsafe(entered, Effect.void);
              return completion.promise;
            },
            deleteCredential: () => {
              deleted = true;
              password = undefined;
              return Promise.resolve(true);
            },
          });
        const native = yield* makeKeychainStore({ entryFactory: factory });
        const auth = yield* make({
          read: (identity) =>
            native
              .read(identity)
              .pipe(
                Effect.flatMap((value) =>
                  value === undefined ? Effect.succeed(undefined) : decodeGrant(value),
                ),
              ),
          write: (identity, value) =>
            encodeGrant(value).pipe(Effect.flatMap((encoded) => native.write(identity, encoded))),
          remove: native.remove,
        });
        const login = yield* auth.login(currentServer, ui).pipe(Effect.result, Effect.forkScoped);
        yield* Deferred.await(entered);
        const logout = yield* auth.logout(currentServer).pipe(Effect.forkScoped);
        expect((yield* Fiber.join(login))._tag).toBe("Failure");
        expect(deleted).toBe(false);
        release();
        yield* Fiber.join(logout);
        expect(password).toBeUndefined();
        expect(deleted).toBe(true);
        expect((yield* auth.access(currentServer).pipe(Effect.result))._tag).toBe("Failure");
      }),
  );
  it.effect("unavailable secure storage prevents browser and registration work", () =>
    Effect.gen(function* () {
      let started = false;
      const auth = yield* make(
        {
          read: () =>
            Effect.fail(boundaryError("unavailable", "not-sent", "Keychain unavailable.")),
          write: () => Effect.void,
          remove: () => Effect.void,
        },
        {
          ...sdk,
          login: (server) =>
            Effect.sync(() => {
              started = true;
              return grant(server.identity);
            }),
        },
      );
      expect((yield* auth.login(server("8"), ui).pipe(Effect.result))._tag).toBe("Failure");
      expect(started).toBe(false);
    }),
  );
  it.effect("versioned grants round-trip and malformed records redact rejected secrets", () =>
    Effect.gen(function* () {
      const value = grant("6".repeat(64));
      expect(yield* decodeGrant(yield* encodeGrant(value))).toEqual(value);
      const rejected = yield* decodeGrant('{"version":99,"secret":"private-token"}').pipe(
        Effect.result,
      );
      expect(rejected._tag).toBe("Failure");
      expect(rejected._tag === "Failure" && rejected.failure.message).not.toContain(
        "private-token",
      );
    }),
  );
});
