import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import {
  encodeGrant,
  type McpGrant,
  type McpRegistrationReceipt,
} from "../../src/auth/credentials.ts";
import { decodeCredentialRecord } from "../../src/auth/credential-record.ts";
import { McpCredentialStore } from "../../src/boundary/credential-store.ts";
import type { KeychainEntryFactory } from "../../src/boundary/keychain.ts";

const identity = "c".repeat(64);
const grant: McpGrant = {
  version: 1,
  identity,
  issuer: "https://issuer.example",
  resource: "https://resource.example/mcp",
  clientId: "public",
  registration: "dynamic",
  redirectUri: "http://127.0.0.1:9000/callback",
  discovery: {},
  resourceMetadata: {},
  clientInformation: { client_id: "public" },
  tokens: { access_token: "private-access", refresh_token: "private-refresh" },
  receivedAt: 0,
};
const registration: McpRegistrationReceipt = {
  identity,
  issuer: grant.issuer,
  resource: grant.resource,
  registration: "dynamic",
  redirectUri: grant.redirectUri,
  clientInformation: { client_id: "replacement" },
  scopes: ["read"],
};
const native = (initial?: string) => {
  let password = initial;
  const accounts = new Set<string>();
  const factory: KeychainEntryFactory = (service, account) => {
    accounts.add(`${service}/${account}`);
    return Promise.resolve({
      getPassword: () => Promise.resolve(password),
      setPassword: (value) => {
        password = value;
        return Promise.resolve();
      },
      deleteCredential: () => {
        password = undefined;
        return Promise.resolve(true);
      },
    });
  };
  return { factory, accounts, value: () => password };
};

it.effect(
  "uses one existing Keychain account for legacy grants, checkpoints, rotation, and logout",
  () =>
    Effect.gen(function* () {
      const storage = native(yield* encodeGrant(grant));
      yield* Effect.gen(function* () {
        const store = yield* McpCredentialStore;
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
        const restarted = yield* McpCredentialStore;
        expect(yield* restarted.readRegistration(identity)).toEqual(registration);
        expect(yield* restarted.read(identity)).toBeUndefined();
      }).pipe(Effect.provide(McpCredentialStore.layer({ entryFactory: storage.factory })));
    }),
);

it.effect(
  "serializes envelope updates across service instances without dropping either receipt",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      let release: () => void = () => undefined;
      let password: string | undefined;
      let first = true;
      const factory: KeychainEntryFactory = () =>
        Promise.resolve({
          getPassword: () => Promise.resolve(password),
          setPassword: (raw) => {
            if (!first) {
              password = raw;
              return Promise.resolve();
            }
            first = false;
            const completion = Promise.withResolvers<void>();
            release = () => {
              password = raw;
              completion.resolve();
            };
            Deferred.doneUnsafe(entered, Effect.void);
            return completion.promise;
          },
          deleteCredential: () => {
            password = undefined;
            return Promise.resolve(true);
          },
        });
      const firstStore = yield* McpCredentialStore.pipe(
        Effect.provide(McpCredentialStore.layer({ entryFactory: factory })),
      );
      const secondStore = yield* McpCredentialStore.pipe(
        Effect.provide(McpCredentialStore.layer({ entryFactory: factory })),
      );
      const checkpoint = yield* firstStore
        .writeRegistration(identity, registration)
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      const replacement = yield* secondStore
        .write(identity, { ...grant, quarantine: "refresh" })
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      release();
      yield* Fiber.join(checkpoint);
      yield* Fiber.join(replacement);
      expect(yield* firstStore.read(identity)).toEqual({ ...grant, quarantine: "refresh" });
      expect(yield* secondStore.readRegistration(identity)).toEqual(registration);
    }),
);

it.effect("rejects cross-account receipts before mutating the existing grant", () =>
  Effect.gen(function* () {
    const storage = native(yield* encodeGrant(grant));
    yield* Effect.gen(function* () {
      const store = yield* McpCredentialStore;
      expect(
        (yield* store
          .writeRegistration(identity, { ...registration, identity: "d".repeat(64) })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(yield* store.read(identity)).toEqual(grant);
      expect(yield* store.readRegistration(identity)).toBeUndefined();
    }).pipe(Effect.provide(McpCredentialStore.layer({ entryFactory: storage.factory })));
  }),
);
