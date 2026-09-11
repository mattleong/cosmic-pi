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
const make = (
  store: Omit<McpCredentialStoreContract, "mutation"> &
    Partial<Pick<McpCredentialStoreContract, "mutation">>,
  auth: McpSdkAuthContract = sdk,
) =>
  makeMcpAuth.pipe(
    Effect.provideService(McpCredentialStore, { mutation: () => Effect.succeed("idle"), ...store }),
    Effect.provideService(McpSdkAuth, auth),
  );

describe("user-only authentication ownership", () => {
  for (const activation of ["challenge", "user-check", "login"] as const)
    it.effect(`keeps implicit OAuth anonymous until ${activation}, then uses stored grants`, () =>
      Effect.gen(function* () {
        const current = server(`implicit-${activation}`);
        if (current.definition?.transport !== "http" || current.definition.auth.type !== "oauth")
          return yield* Effect.die("Missing OAuth fixture.");
        const implicit = {
          ...current,
          definition: {
            ...current.definition,
            auth: { ...current.definition.auth, implicit: true as const },
          },
        };
        let activated = false;
        let saved: McpGrant | undefined;
        const auth = yield* make({
          read: () =>
            activated ? Effect.succeed(saved) : Effect.die("Anonymous access read secure storage."),
          write: (_identity, value) =>
            Effect.sync(() => {
              saved = value;
            }),
          remove: () => Effect.void,
        });
        expect(yield* auth.access(implicit)).toBeUndefined();
        expect(yield* auth.access(implicit)).toBeUndefined();
        expect(yield* auth.status(implicit)).toEqual({ state: "unchecked" });
        activated = true;
        if (activation === "login") {
          const receipt = yield* auth.login(implicit, ui);
          yield* auth.completeLogin(implicit, receipt);
        } else {
          if (activation === "challenge") yield* auth.reject(implicit);
          expect(
            yield* auth
              .access(implicit, { requireGrant: activation === "user-check" })
              .pipe(Effect.flip),
          ).toMatchObject({
            kind: "auth-required",
            reason: "auth-oauth-required",
            outcome: "not-sent",
          });
          expect(yield* auth.status(implicit)).toEqual({ state: "required" });
          saved = grant(current.identity, Number.MAX_SAFE_INTEGER);
        }
        expect(yield* auth.access(implicit)).toBe("private-token");
        expect(yield* auth.status(implicit)).toEqual({ state: "ready" });
        yield* auth.revoke;
        activated = false;
        expect(yield* auth.access(implicit)).toBeUndefined();
        expect(yield* auth.status(implicit)).toEqual({ state: "unchecked" });
        activated = true;
        yield* auth.reject(implicit);
        expect(yield* auth.access(implicit)).toBe("private-token");
        yield* auth.logout(implicit);
        expect(yield* auth.access(implicit).pipe(Effect.flip)).toMatchObject({
          kind: "auth-required",
        });
      }),
    );
  it.effect(
    "explains non-OAuth login and missing environment credentials without starting sign-in",
    () =>
      Effect.gen(function* () {
        const forbidden = Effect.die("non-OAuth recovery touched OAuth or storage");
        const auth = yield* make(
          { read: () => forbidden, write: () => forbidden, remove: () => forbidden },
          { login: () => forbidden, refresh: () => forbidden, token: () => forbidden },
        );
        for (const mode of [
          { type: "none" as const },
          { type: "env" as const, env: "PRIVATE_MISSING_ENV" },
        ]) {
          const current: McpEffectiveServer = {
            ...server("diagnostic"),
            definition: {
              transport: "http",
              url: "https://resource.example/mcp",
              headers: {},
              denyTools: [],
              auth: mode,
            },
          };
          expect(yield* auth.login(current, ui).pipe(Effect.flip)).toMatchObject({
            kind: mode.type === "none" ? "auth-required" : "unsupported",
            outcome: "not-sent",
            reason: mode.type === "none" ? "auth-not-configured" : "auth-env-sign-in-unsupported",
          });
          if (mode.type === "none") expect(yield* auth.access(current)).toBeUndefined();
          else
            expect(yield* auth.access(current).pipe(Effect.flip)).toMatchObject({
              kind: "auth-required",
              outcome: "not-sent",
              reason: "auth-env-required",
            });
        }
      }).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord({})),
      ),
  );
  it.effect(
    "unsupported browser sign-in does not invalidate a checked environment credential",
    () =>
      Effect.gen(function* () {
        const forbidden = Effect.die("environment sign-in touched OAuth or storage");
        const auth = yield* make(
          { read: () => forbidden, write: () => forbidden, remove: () => forbidden },
          { login: () => forbidden, refresh: () => forbidden, token: () => forbidden },
        );
        const current: McpEffectiveServer = {
          ...server("env-login"),
          definition: {
            transport: "http",
            url: "https://resource.example/mcp",
            headers: {},
            denyTools: [],
            auth: { type: "env", env: "PRIVATE_ENV" },
          },
        };
        expect(yield* auth.access(current)).toBe("private-token");
        const before = yield* auth.status(current);
        expect(before.state).toBe("ready");
        expect(yield* auth.login(current, ui).pipe(Effect.flip)).toMatchObject({
          kind: "unsupported",
          outcome: "not-sent",
          reason: "auth-env-sign-in-unsupported",
        });
        expect(yield* auth.status(current)).toEqual(before);
      }).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord({ PRIVATE_ENV: "private-token" }),
        ),
      ),
  );
  it.effect("status performs no store, SDK, or environment lookup", () =>
    Effect.gen(function* () {
      const forbidden = Effect.die("status touched a credential boundary");
      const auth = yield* make({
        read: () => forbidden,
        write: () => forbidden,
        remove: () => forbidden,
      });
      expect(yield* auth.status(server("1"))).toEqual({ state: "unchecked" });
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
      expect(yield* auth.status(env)).toEqual({ state: "unchecked" });
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
          mutation: () => Effect.succeed("idle"),
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
          mutation: native.mutation,
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
  it.effect("publishes ready only from the exact still-current outer login receipt", () =>
    Effect.gen(function* () {
      const current = server("a");
      const auth = yield* make({
        read: () => Effect.succeed(undefined),
        write: () => Effect.void,
        remove: () => Effect.void,
      });
      const first = yield* auth.login(current, ui);
      expect(yield* auth.status(current)).toEqual({ state: "unavailable" });
      yield* auth.completeLogin(current, { state: "ready" });
      expect(yield* auth.status(current)).toEqual({ state: "unavailable" });
      yield* auth.completeLogin(current, first);
      expect(yield* auth.status(current)).toEqual({ state: "ready" });
      const second = yield* auth.login(current, ui);
      yield* auth.finalizationFailed(current, second);
      expect(yield* auth.status(current)).toEqual({ state: "unavailable" });
      yield* auth.completeLogin(current, second);
      expect(yield* auth.status(current)).toEqual({ state: "unavailable" });
      const third = yield* auth.login(current, ui);
      yield* auth.reject(current);
      yield* auth.completeLogin(current, third);
      expect(yield* auth.status(current)).toEqual({ state: "required" });
      const fourth = yield* auth.login(current, ui);
      yield* auth.revoke;
      yield* auth.completeLogin(current, fourth);
      expect(yield* auth.status(current)).toEqual({ state: "unchecked" });
    }),
  );

  it.effect("does not let an older credential check erase current-owner auth rejection", () =>
    Effect.gen(function* () {
      const current = server("b");
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const auth = yield* make(
        {
          read: () => Effect.succeed(grant(current.identity)),
          write: () => Effect.void,
          remove: () => Effect.void,
        },
        {
          ...sdk,
          token: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as("PRIVATE_TOKEN"),
            ),
        },
      );
      const access = yield* auth.access(current).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* auth.reject(current);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(access);
      expect(yield* auth.status(current)).toEqual({ state: "required" });
    }),
  );

  it.effect("reports native mutation blocking without an additional credential read", () =>
    Effect.gen(function* () {
      let reads = 0;
      const auth = yield* make({
        read: () =>
          Effect.sync(() => {
            reads++;
            return undefined;
          }),
        write: () => Effect.void,
        remove: () => Effect.void,
        mutation: () => Effect.succeed("pending"),
      });
      expect(yield* auth.status(server("d"))).toEqual({ state: "unavailable" });
      expect(reads).toBe(0);
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
