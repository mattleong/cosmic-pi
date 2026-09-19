import { it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { describe, expect } from "vitest";
import {
  decodeGrant,
  encodeGrant,
  type McpGrant,
  type McpRegistrationReceipt,
} from "../../src/auth/credentials.ts";
import { getAuthChallenge, setAuthChallenge } from "../../src/auth/challenge.ts";
import type { McpLoginOptions, McpLoginUi } from "../../src/auth/model.ts";
import { transactionStore } from "../fixtures/credential-store.ts";
import { makeMcpAuth, makeMcpAuthWithAuthority } from "../../src/auth/service.ts";
import type { McpAuthLiveAuthority } from "../../src/auth/authority.ts";
import {
  McpCredentialStore,
  type McpCredentialStoreContract,
} from "../../src/boundary/credential-store.ts";
import { McpSdkAuth, type McpSdkAuthContract } from "../../src/boundary/sdk-auth.ts";
import { boundaryError } from "../../src/client/errors.ts";
import { makeKeychainStore, type KeychainEntryFactory } from "../../src/boundary/keychain.ts";
import type { McpEffectiveServer } from "../../src/config/model.ts";

const serialize = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
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
  store: Omit<
    McpCredentialStoreContract,
    "mutation" | "readRegistration" | "writeRegistration" | "withTransaction"
  > &
    Partial<
      Pick<McpCredentialStoreContract, "mutation" | "readRegistration" | "writeRegistration">
    >,
  auth: McpSdkAuthContract = sdk,
  live?: McpAuthLiveAuthority,
) =>
  (live ? makeMcpAuthWithAuthority(live) : makeMcpAuth).pipe(
    Effect.provideService(
      McpCredentialStore,
      transactionStore({
        mutation: () => Effect.succeed("idle"),
        readRegistration: () => Effect.succeed(undefined),
        writeRegistration: () => Effect.void,
        ...store,
      }),
    ),
    Effect.provideService(McpSdkAuth, auth),
  );

describe("user-only authentication ownership", () => {
  it.effect("rejects remote plaintext bearer destinations before environment lookup", () =>
    Effect.gen(function* () {
      const current: McpEffectiveServer = {
        ...server("plaintext"),
        definition: {
          transport: "http",
          url: "http://remote.example/mcp",
          headers: {},
          denyTools: [],
          auth: { type: "env", env: "MISSING_PLAINTEXT_TOKEN" },
        },
      };
      const auth = yield* make({
        read: () => Effect.die("Unexpected storage lookup"),
        write: () => Effect.void,
        remove: () => Effect.void,
      });
      expect(yield* auth.access(current).pipe(Effect.flip)).toMatchObject({ kind: "denied" });
    }),
  );

  for (const loss of ["trust", "configuration"] as const)
    it.effect(
      `rechecks live ${loss} after headless credential waiting before refresh or publication`,
      () =>
        Effect.gen(function* () {
          const current = server(`live-${loss}`);
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          let valid = true;
          const live: McpAuthLiveAuthority = {
            isTrusted: () => loss !== "trust" || valid,
            check: () =>
              Effect.suspend(() =>
                valid ? Effect.void : Effect.fail(boundaryError("stale", "not-sent", "Revoked")),
              ),
          };
          const forbidden = Effect.die("Revoked headless access reached credentials or network");
          const auth = yield* make(
            {
              read: () =>
                Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.as(grant(current.identity)),
                ),
              write: () => forbidden,
              remove: () => Effect.void,
            },
            { ...sdk, refresh: () => forbidden, token: () => forbidden },
            live,
          );
          const access = yield* auth.access(current).pipe(Effect.flip, Effect.forkScoped);
          yield* Deferred.await(entered);
          valid = false;
          yield* Deferred.succeed(release, undefined);
          expect(yield* Fiber.join(access)).toMatchObject({ kind: "stale" });
        }),
    );

  it.live("withdraws headless authority while a credential read remains pending", () =>
    Effect.gen(function* () {
      const current = server("headless-wait");
      const entered = yield* Deferred.make<void>();
      let trusted = true;
      const auth = yield* make(
        {
          read: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
          write: () => Effect.die("Revoked write"),
          remove: () => Effect.void,
        },
        sdk,
        { isTrusted: () => trusted, check: () => Effect.void },
      );
      const access = yield* auth.access(current).pipe(Effect.flip, Effect.forkScoped);
      yield* Deferred.await(entered);
      trusted = false;
      expect(yield* Fiber.join(access).pipe(Effect.timeout("1 second"))).toMatchObject({
        kind: "stale",
      });
    }).pipe(Effect.scoped),
  );
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
          reason: "auth-oauth-required",
          outcome: "not-sent",
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
        const store = transactionStore({
          mutation: () => Effect.succeed("idle"),
          readRegistration: () => Effect.succeed(undefined),
          writeRegistration: () => Effect.void,
          read: () => Effect.sync(() => stored),
          write: (_identity, value) =>
            Effect.sync(() => {
              stored = value;
            }),
          remove: () =>
            Effect.sync(() => {
              stored = undefined;
            }),
        });
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
      expect(yield* auth.status(currentServer)).toEqual({ state: "required" });
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
      const access = yield* auth.access(current).pipe(Effect.result, Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* auth.reject(current, { credentialUsed: true });
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(access)).toMatchObject({
        _tag: "Failure",
        failure: { kind: "stale" },
      });
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

  for (const failure of [
    "marker-save",
    "refresh",
    "cancel",
    "validation",
    "replacement-save",
    "replacement-save-after-write",
  ] as const)
    it.effect(`never retries a consumed refresh token after ${failure} failure`, () =>
      Effect.gen(function* () {
        const current = server(`consume-${failure}`);
        let stored = grant(current.identity);
        let refreshes = 0;
        let writes = 0;
        const entered = yield* Deferred.make<void>();
        const failed = () => boundaryError("unavailable", "not-sent", "Owned boundary failed.");
        const storage = {
          read: () => Effect.sync(() => structuredClone(stored)),
          write: (_identity: string, value: McpGrant) =>
            Effect.gen(function* () {
              writes++;
              if (
                (failure === "marker-save" && value.quarantine) ||
                (failure === "replacement-save" && !value.quarantine)
              )
                return yield* failed();
              stored = structuredClone(value);
              if (failure === "replacement-save-after-write" && !value.quarantine)
                return yield* failed();
            }),
          remove: () => Effect.void,
        };
        const boundary: McpSdkAuthContract = {
          ...sdk,
          refresh: (_server, original) =>
            Effect.gen(function* () {
              refreshes++;
              expect(original.quarantine).toBeUndefined();
              expect(stored.quarantine).toBe("refresh");
              expect(stored.tokens).toEqual(original.tokens);
              yield* Deferred.succeed(entered, undefined);
              if (failure === "cancel") return yield* Effect.never;
              if (failure === "refresh") return yield* failed();
              return {
                ...original,
                expiresAt: Number.MAX_SAFE_INTEGER,
                tokens: { access_token: "replacement" },
              };
            }),
          token: () =>
            failure === "validation" ? Effect.fail(failed()) : Effect.succeed("replacement"),
        };
        const auth = yield* make(storage, boundary);
        if (failure === "cancel") {
          const attempt = yield* auth.access(current).pipe(Effect.forkScoped);
          yield* Deferred.await(entered);
          yield* Fiber.interrupt(attempt);
        } else expect((yield* auth.access(current).pipe(Effect.result))._tag).toBe("Failure");
        expect(stored.quarantine).toBe(
          failure === "marker-save" || failure === "replacement-save-after-write"
            ? undefined
            : "refresh",
        );
        if (failure === "replacement-save-after-write")
          expect(stored.tokens).toEqual({ access_token: "replacement" });
        expect(refreshes).toBe(failure === "marker-save" ? 0 : 1);
        const before = { refreshes, writes };
        for (const check of ["first", "repeat", "revoked", "replacement"]) {
          if (check === "revoked") yield* auth.revoke;
          const owner = check === "replacement" ? yield* make(storage, boundary) : auth;
          expect(yield* owner.access(current).pipe(Effect.flip)).toMatchObject({
            kind: "auth-required",
            reason: "oauth-refresh-unresolved",
            outcome: "not-sent",
          });
          expect(yield* owner.status(current)).toEqual({ state: "required" });
        }
        expect({ refreshes, writes }).toEqual(before);
      }),
    );

  it.effect("restored quarantined grants never reach token validation or refresh", () =>
    Effect.gen(function* () {
      const current = server("restored-mark");
      const forbidden = Effect.die("A consumed credential reached the SDK.");
      const stored: McpGrant = {
        ...grant(current.identity, Number.MAX_SAFE_INTEGER),
        quarantine: "refresh",
      };
      const storage = {
        read: () => Effect.succeed(stored),
        write: () => forbidden,
        remove: () => Effect.void,
      };
      const boundary = { ...sdk, token: () => forbidden, refresh: () => forbidden };
      const auth = yield* make(storage, boundary);
      expect(yield* auth.status(current)).toEqual({ state: "unchecked" });
      for (const check of ["first", "repeat", "revoked", "replacement"]) {
        if (check === "revoked") yield* auth.revoke;
        const owner = check === "replacement" ? yield* make(storage, boundary) : auth;
        expect(yield* owner.access(current).pipe(Effect.flip)).toMatchObject({
          kind: "auth-required",
          reason: "oauth-refresh-unresolved",
          outcome: "not-sent",
        });
        expect(yield* owner.status(current)).toEqual({ state: "required" });
      }
    }),
  );

  it.effect("ignored native refresh cancellation cannot commit after a replacement login", () =>
    Effect.gen(function* () {
      const current = server("late-refresh");
      let stored = grant(current.identity);
      let finish: (value: McpGrant) => void = () => undefined;
      const entered = yield* Deferred.make<void>();
      const fresh = {
        ...grant(current.identity, Number.MAX_SAFE_INTEGER),
        tokens: { access_token: "explicit-login" },
      };
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
          login: () => Effect.succeed(fresh),
          refresh: () =>
            Effect.tryPromise({
              try: () => {
                const pending = Promise.withResolvers<McpGrant>();
                finish = pending.resolve;
                Deferred.doneUnsafe(entered, Effect.void);
                return pending.promise;
              },
              catch: () => boundaryError("unavailable", "not-sent", "Refresh failed."),
            }),
        },
      );
      const attempt = yield* auth.access(current).pipe(Effect.result, Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* auth.revoke;
      expect((yield* Fiber.join(attempt))._tag).toBe("Failure");
      expect(stored.quarantine).toBe("refresh");
      expect(yield* auth.access(current).pipe(Effect.flip)).toMatchObject({
        kind: "auth-required",
        reason: "oauth-refresh-unresolved",
        outcome: "not-sent",
      });
      const receipt = yield* auth.login(current, ui);
      yield* auth.completeLogin(current, receipt);
      finish({ ...fresh, tokens: { access_token: "late-token" } });
      yield* Effect.yieldNow;
      expect(stored).toEqual(fresh);
      expect(yield* auth.status(current)).toEqual({ state: "ready" });
    }),
  );

  for (const revocation of ["session", "rejection"] as const)
    it.effect(`a late durable refresh save cannot clear ${revocation} ownership`, () =>
      Effect.gen(function* () {
        const current = server(`late-save-${revocation}`);
        let stored = grant(current.identity);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const auth = yield* make(
          {
            read: () => Effect.sync(() => stored),
            write: (_identity, value) =>
              Effect.uninterruptible(
                Effect.gen(function* () {
                  if (!value.quarantine) {
                    yield* Deferred.succeed(entered, undefined);
                    yield* Deferred.await(release);
                  }
                  stored = value;
                }),
              ),
            remove: () => Effect.void,
          },
          {
            ...sdk,
            refresh: (_server, original) =>
              Effect.succeed({ ...original, expiresAt: Number.MAX_SAFE_INTEGER }),
          },
        );
        const attempt = yield* auth.access(current).pipe(Effect.result, Effect.forkScoped);
        yield* Deferred.await(entered);
        if (revocation === "session") yield* auth.revoke;
        else yield* auth.reject(current, { credentialUsed: true });
        yield* Deferred.succeed(release, undefined);
        expect((yield* Fiber.join(attempt))._tag).toBe("Failure");
        expect(yield* auth.access(current).pipe(Effect.flip)).toMatchObject({
          kind: "auth-required",
          reason: revocation === "session" ? "oauth-refresh-unresolved" : "oauth-token-rejected",
          outcome: "not-sent",
        });
        expect(yield* auth.status(current)).toEqual({ state: "required" });
      }),
    );

  for (const rejectionReason of [undefined, "oauth-insufficient-scope"] as const)
    for (const expiration of [undefined, Number.MAX_SAFE_INTEGER])
      it.effect(
        `credential rejection ${rejectionReason} blocks expiry ${expiration} until explicit login`,
        () =>
          Effect.gen(function* () {
            const current = server(`rejected-${rejectionReason}-${expiration}`);
            let stored: McpGrant = { ...grant(current.identity), expiresAt: expiration };
            let reads = 0;
            const storage = {
              read: () =>
                Effect.sync(() => {
                  reads++;
                  return stored;
                }),
              write: (_identity: string, value: McpGrant) =>
                Effect.sync(() => {
                  stored = value;
                }),
              remove: () => Effect.void,
            };
            const auth = yield* make(storage, {
              ...sdk,
              login: () => Effect.succeed({ ...stored, tokens: { access_token: "new" } }),
            });
            const challenge = {
              status: 403 as const,
              wwwAuthenticate: 'Bearer scope="PRIVATE_SCOPE"',
            };
            const rejection = setAuthChallenge(
              boundaryError("auth-required", "unknown", "PRIVATE_RPC_REJECTION", rejectionReason),
              challenge,
            );
            const original = serialize(rejection);
            expect(yield* auth.access(current)).toBe("private-token");
            yield* auth.reject(current, { credentialUsed: true, error: rejection });
            const before = reads;
            for (const check of ["first", "repeat", "revoked", "replacement"]) {
              if (check === "revoked") yield* auth.revoke;
              const owner = check === "replacement" ? yield* make(storage) : auth;
              const blocked = yield* owner.access(current).pipe(Effect.flip);
              expect(blocked).toMatchObject({
                kind: "auth-required",
                reason: rejectionReason ?? "oauth-token-rejected",
                outcome: "not-sent",
              });
              expect(getAuthChallenge(blocked)).toBeUndefined();
              expect(serialize(blocked)).not.toContain("PRIVATE_");
              expect(yield* owner.status(current)).toEqual({ state: "required" });
              expect(reads).toBe(before);
            }
            expect(serialize(rejection)).toBe(original);
            expect(rejection.outcome).toBe("unknown");
            expect(getAuthChallenge(rejection)).toEqual(challenge);
            const receipt = yield* auth.login(current, ui);
            yield* auth.completeLogin(current, receipt);
            expect(yield* auth.access(current)).toBe("private-token");
            expect(yield* auth.status(current)).toEqual({ state: "ready" });
            yield* auth.logout(current);
            expect(yield* auth.access(current).pipe(Effect.flip)).toMatchObject({
              kind: "auth-required",
              reason: "auth-oauth-required",
              outcome: "not-sent",
            });
          }),
      );

  it.effect(
    "retains identity-scoped private challenges only until revoke or a current successful login",
    () =>
      Effect.gen(function* () {
        const current = server("private-challenge");
        const other = server("other-challenge");
        const challenge = { status: 403 as const, wwwAuthenticate: 'Bearer scope="private-scope"' };
        const error = setAuthChallenge(
          boundaryError("auth-required", "unknown", "Rejected."),
          challenge,
        );
        const seen: Array<McpLoginOptions | undefined> = [];
        let fail = true;
        const auth = yield* make(
          {
            read: () => Effect.succeed(undefined),
            write: () => Effect.void,
            remove: () => Effect.void,
          },
          {
            ...sdk,
            login: (server, _ui, options) =>
              Effect.gen(function* () {
                seen.push(options);
                if (fail) return yield* boundaryError("cancelled", "not-sent", "Cancelled.");
                return grant(server.identity, Number.MAX_SAFE_INTEGER);
              }),
          },
        );
        yield* auth.reject(current, { credentialUsed: true, error });
        yield* auth.login(current, ui).pipe(Effect.result);
        expect(seen.at(-1)?.challenge).toEqual(challenge);
        yield* auth.login(other, ui).pipe(Effect.result);
        expect(seen.at(-1)?.challenge).toBeUndefined();
        expect(serialize(yield* auth.status(current))).not.toContain("private-scope");
        fail = false;
        yield* auth.login(current, ui);
        expect(seen.at(-1)?.challenge).toEqual(challenge);
        yield* auth.login(current, ui);
        expect(seen.at(-1)?.challenge).toBeUndefined();
        yield* auth.reject(current, { credentialUsed: false, error });
        yield* auth.revoke;
        yield* auth.login(current, ui);
        expect(seen.at(-1)?.challenge).toBeUndefined();
        yield* auth.reject(current, { credentialUsed: false, error });
        yield* auth.logout(current);
        yield* auth.login(current, ui);
        expect(seen.at(-1)?.challenge).toBeUndefined();
      }),
  );

  it.effect(
    "checkpoints registration on cancelled replacement login without replacing a working grant",
    () =>
      Effect.gen(function* () {
        const current = server("checkpoint-cancel");
        const previous = grant(current.identity, Number.MAX_SAFE_INTEGER);
        let stored = previous;
        let registration: McpRegistrationReceipt | undefined;
        let callback: McpLoginOptions["saveRegistration"];
        const receipt: McpRegistrationReceipt = {
          identity: current.identity,
          issuer: previous.issuer,
          resource: previous.resource,
          registration: "dynamic",
          redirectUri: previous.redirectUri,
          clientInformation: { client_id: "new-client" },
          scopes: ["read"],
        };
        let checkpoints = 0;
        let credentialsSaved = false;
        const auth = yield* make(
          {
            read: () => Effect.sync(() => stored),
            readRegistration: () => Effect.sync(() => registration),
            writeRegistration: (_identity, value) =>
              Effect.sync(() => {
                registration = structuredClone(value);
                checkpoints++;
              }),
            write: (_identity, value) =>
              Effect.sync(() => {
                stored = value;
              }),
            remove: () => Effect.void,
          },
          {
            ...sdk,
            login: (_server, _ui, options) =>
              Effect.gen(function* () {
                expect(options?.previousGrant).toEqual(previous);
                expect(options?.registration).toEqual(registration);
                callback = options?.saveRegistration;
                yield* callback!(receipt);
                return yield* boundaryError("cancelled", "not-sent", "Cancelled replacement.");
              }),
          },
        );
        expect(yield* auth.access(current)).toBe("private-token");
        yield* auth
          .login(current, {
            ...ui,
            progress: (event) =>
              Effect.sync(() => {
                credentialsSaved ||= event.credentialsSaved === true;
              }),
          })
          .pipe(Effect.result);
        expect(stored).toEqual(previous);
        expect(registration).toEqual(receipt);
        expect(credentialsSaved).toBe(false);
        expect(yield* auth.access(current)).toBe("private-token");
        expect(yield* callback!(receipt).pipe(Effect.flip)).toMatchObject({ kind: "stale" });
        expect(checkpoints).toBe(1);
        yield* auth.login(current, ui).pipe(Effect.result);
        expect(checkpoints).toBe(2);
      }),
  );
});
