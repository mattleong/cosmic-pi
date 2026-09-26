import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { authorityFor, withCredentialPermit } from "../../src/auth/authority.ts";
import { makeMcpAuthWithAuthority } from "../../src/auth/service.ts";
import { McpSdkAuth } from "../../src/boundary/sdk-auth.ts";
import { decodeCredentialRecord } from "../../src/auth/credential-record.ts";
import { McpCredentialStore } from "../../src/boundary/credential-store.ts";
import type { KeychainEntryFactory } from "../../src/boundary/keychain.ts";
import { boundaryError } from "../../src/client/errors.ts";
import { manualUi, oauthServer, testGrant, testRegistration } from "../fixtures/auth.ts";
import { flat } from "../fixtures/credential-store.ts";
import { heldKeychain, memoryKeychain } from "../fixtures/keychain.ts";

const serialize = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const identity = "c".repeat(64);
const grant = testGrant(identity);
const registration = testRegistration(grant, { clientInformation: { client_id: "replacement" } });

for (const guard of ["trust", "configuration"] as const)
  for (const operation of ["read", "write", "remove"] as const)
    it.effect(`rechecks ${guard} after entry acquisition before native ${operation}`, () =>
      Effect.gen(function* () {
        let valid = true;
        let factories = 0;
        let reads = 0;
        let writes = 0;
        let deletes = 0;
        const factory: KeychainEntryFactory = () => {
          if (++factories === (operation === "write" ? 2 : 1)) valid = false;
          return Promise.resolve({
            getPassword: () => {
              reads++;
              return Promise.resolve(undefined);
            },
            setPassword: () => {
              writes++;
              return Promise.resolve();
            },
            deleteCredential: () => {
              deletes++;
              return Promise.resolve(true);
            },
          });
        };
        const store = yield* McpCredentialStore.pipe(
          Effect.provide(McpCredentialStore.layer({ entryFactory: factory })),
        );
        const checkCurrent = Effect.suspend(() =>
          valid ? Effect.void : Effect.fail(boundaryError("stale", "not-sent", "Config revoked")),
        );
        const failure = yield* store
          .withTransaction(
            identity,
            (tx) =>
              operation === "write"
                ? tx.write(grant)
                : operation === "read"
                  ? Effect.asVoid(tx.read)
                  : tx.remove,
            guard === "trust"
              ? { isCurrent: () => valid }
              : { checkCurrent, isCurrent: () => true },
          )
          .pipe(Effect.flip);
        if (guard === "configuration") expect(failure).toMatchObject({ kind: "stale" });
        expect(reads).toBe(operation === "write" ? 1 : 0);
        expect(writes).toBe(0);
        expect(deletes).toBe(0);
      }),
    );

it.effect(
  "uses one existing Keychain account for legacy grants, checkpoints, rotation, and logout",
  () =>
    Effect.gen(function* () {
      const storage = memoryKeychain(serialize(grant));
      yield* Effect.gen(function* () {
        const store = flat(yield* McpCredentialStore);
        expect(yield* store.read(identity)).toEqual(grant);
        expect(yield* store.readRegistration(identity)).toBeUndefined();
        yield* store.writeRegistration(identity, registration);
        expect(yield* store.read(identity)).toEqual(grant);
        const marked = { ...grant, quarantine: "refresh" as const };
        yield* store.write(identity, marked);
        expect(yield* store.readRegistration(identity)).toEqual(registration);
        const changed = { ...registration, scopes: ["read", "write"] };
        yield* store.writeRegistration(identity, changed);
        expect(yield* store.read(identity)).toEqual(marked);
        expect(yield* decodeCredentialRecord(storage.value()!)).toEqual({
          version: 2,
          grant: marked,
          registration: changed,
        });
        yield* store.write(identity, { ...grant, tokens: { access_token: "rotated" } });
        expect(yield* store.readRegistration(identity)).toEqual(changed);
        yield* store.remove(identity);
        expect(yield* store.read(identity)).toBeUndefined();
        expect(yield* store.readRegistration(identity)).toBeUndefined();
        yield* store.writeRegistration(identity, registration);
        expect(yield* store.read(identity)).toBeUndefined();
      }).pipe(Effect.provide(McpCredentialStore.layer({ entryFactory: storage.factory })));
      expect([...storage.accounts]).toEqual([`com.cosmic-pi.mcp.oauth.v1/${identity}`]);
      yield* Effect.gen(function* () {
        const restarted = flat(yield* McpCredentialStore);
        expect(yield* restarted.readRegistration(identity)).toEqual(registration);
        expect(yield* restarted.read(identity)).toBeUndefined();
      }).pipe(Effect.provide(McpCredentialStore.layer({ entryFactory: storage.factory })));
    }),
);

it.effect(
  "serializes envelope updates across service instances without dropping either receipt",
  () =>
    Effect.gen(function* () {
      const native = yield* heldKeychain({ firstOnly: true });
      const firstStore = flat(
        yield* McpCredentialStore.pipe(
          Effect.provide(McpCredentialStore.layer({ entryFactory: native.factory })),
        ),
      );
      const secondStore = flat(
        yield* McpCredentialStore.pipe(
          Effect.provide(McpCredentialStore.layer({ entryFactory: native.factory })),
        ),
      );
      const checkpoint = yield* firstStore
        .writeRegistration(identity, registration)
        .pipe(Effect.forkScoped);
      yield* Deferred.await(native.entered);
      const replacement = yield* secondStore
        .write(identity, { ...grant, quarantine: "refresh" })
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      native.release();
      yield* Fiber.join(checkpoint);
      yield* Fiber.join(replacement);
      expect(yield* firstStore.read(identity)).toEqual({ ...grant, quarantine: "refresh" });
      expect(yield* secondStore.readRegistration(identity)).toEqual(registration);
    }),
);

it.effect("rejects cross-account receipts before mutating the existing grant", () =>
  Effect.gen(function* () {
    const storage = memoryKeychain(serialize(grant));
    yield* Effect.gen(function* () {
      const store = flat(yield* McpCredentialStore);
      expect(
        yield* store
          .writeRegistration(identity, { ...registration, identity: "d".repeat(64) })
          .pipe(Effect.isFailure),
      ).toBe(true);
      expect(yield* store.read(identity)).toEqual(grant);
      expect(yield* store.readRegistration(identity)).toBeUndefined();
    }).pipe(Effect.provide(McpCredentialStore.layer({ entryFactory: storage.factory })));
  }),
);

for (const stop of ["timeout", "cancel", "trust"] as const)
  it.effect(`ends local credential admission on ${stop} without ending the admitted callback`, () =>
    Effect.gen(function* () {
      const storage = memoryKeychain();
      const store = yield* McpCredentialStore.pipe(
        Effect.provide(
          McpCredentialStore.layer({
            entryFactory: storage.factory,
            acquireTimeoutMs: 100,
            timeoutMs: 10,
          }),
        ),
      );
      const entered = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      let trusted = true;
      const holder = yield* store
        .withTransaction(identity, () =>
          Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(finish)),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      const waiting = yield* store
        .withTransaction(identity, (tx) => tx.read, { isCurrent: () => trusted })
        .pipe(Effect.flip, Effect.forkScoped);
      if (stop === "cancel") {
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(waiting);
      } else {
        if (stop === "trust") trusted = false;
        yield* TestClock.adjust(100);
        expect(yield* Fiber.join(waiting)).toMatchObject(
          stop === "timeout"
            ? { kind: "timeout", reason: "oauth-coordination-timeout", outcome: "not-sent" }
            : { kind: "stale" },
        );
      }
      expect(storage.accounts.size).toBe(0);
      yield* TestClock.adjust(10_000);
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(holder);
      expect(yield* flat(store).read(identity)).toBeUndefined();
    }),
  );

for (const operation of ["access", "login", "logout"] as const)
  it.effect(`bounds the upstream auth authority permit for ${operation}`, () =>
    Effect.gen(function* () {
      const configured = oauthServer(
        (operation === "access" ? "1" : operation === "login" ? "2" : "3").repeat(64),
      );
      const storage = memoryKeychain();
      const store = yield* McpCredentialStore.pipe(
        Effect.provide(McpCredentialStore.layer({ entryFactory: storage.factory })),
      );
      const auth = yield* makeMcpAuthWithAuthority(
        { check: () => Effect.void, isTrusted: () => true },
        { acquireTimeoutMs: 100 },
      ).pipe(
        Effect.provideService(McpCredentialStore, store),
        Effect.provideService(McpSdkAuth, {
          token: () => Effect.die("Must not reach SDK"),
          refresh: () => Effect.die("Must not reach SDK"),
          login: () => Effect.die("Must not reach SDK"),
        }),
      );
      const entered = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const holder = yield* withCredentialPermit(
        authorityFor(configured.identity).permit,
        Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(finish)),
        Effect.void,
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      const work =
        operation === "login"
          ? auth.login(configured, manualUi)
          : operation === "logout"
            ? auth.logout(configured)
            : auth.access(configured);
      const waiting = yield* work.pipe(Effect.flip, Effect.forkScoped);
      yield* TestClock.adjust(100);
      expect(yield* Fiber.join(waiting)).toMatchObject({
        kind: "timeout",
        reason: "oauth-coordination-timeout",
        outcome: "not-sent",
      });
      expect(storage.accounts.size).toBe(0);
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(holder);
      expect(yield* authorityFor(configured.identity).permit.takeIfAvailable(1)).toBe(true);
      yield* authorityFor(configured.identity).permit.release(1);
    }),
  );
