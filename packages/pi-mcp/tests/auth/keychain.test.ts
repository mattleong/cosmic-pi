import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { it } from "@effect/vitest";
import * as Config from "effect/Config";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { yieldUntil } from "pi-cosmic-core/testing";
import { describe, expect } from "vitest";
import { makeKeychainStore, type KeychainEntryFactory } from "../../src/boundary/keychain.ts";
import { heldKeychain, memoryKeychain } from "../fixtures/keychain.ts";

const identity = "c".repeat(64);
describe("Keychain native mutation ownership", () => {
  it.effect("checks live authority after native entry acquisition before mutating", () =>
    Effect.gen(function* () {
      let trusted = true;
      let writes = 0;
      const store = yield* makeKeychainStore({
        entryFactory: () => {
          trusted = false;
          return Promise.resolve({
            getPassword: () => Promise.resolve(undefined),
            setPassword: () => {
              writes++;
              return Promise.resolve();
            },
            deleteCredential: () => Promise.resolve(true),
          });
        },
      });
      expect(
        yield* store.write(identity, "grant", { isCurrent: () => trusted }).pipe(Effect.isFailure),
      ).toBe(true);
      expect(writes).toBe(0);
    }),
  );
  it.effect(
    "exposes pending and blocked mutation facts without new reads or indefinite joins",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const completion = Promise.withResolvers<void>();
        let entryCalls = 0;
        let reads = 0;
        const factory: KeychainEntryFactory = () => {
          entryCalls++;
          return Promise.resolve({
            getPassword: () => {
              reads++;
              return Promise.resolve(undefined);
            },
            setPassword: () => {
              Deferred.doneUnsafe(entered, Effect.void);
              return completion.promise;
            },
            deleteCredential: () => Promise.resolve(true),
          });
        };
        const store = yield* makeKeychainStore({ entryFactory: factory, timeoutMs: 100 });
        expect(yield* store.mutation(identity)).toBe("idle");
        expect(entryCalls).toBe(0);
        const saving = yield* store
          .write(identity, "PRIVATE_GRANT")
          .pipe(Effect.result, Effect.forkScoped);
        yield* Deferred.await(entered);
        expect(yield* store.mutation(identity)).toBe("pending");
        yield* TestClock.adjust(101);
        expect(yield* Fiber.join(saving)).toMatchObject({
          _tag: "Failure",
          failure: { reason: "oauth-mutation-unresolved" },
        });
        expect(yield* store.mutation(identity)).toBe("pending");
        const deleting = yield* store.remove(identity).pipe(Effect.result, Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* TestClock.adjust(101);
        expect(yield* Fiber.join(deleting)).toMatchObject({
          _tag: "Failure",
          failure: { reason: "oauth-deletion-failed" },
        });
        expect(yield* store.mutation(identity)).toBe("pending");
        completion.resolve();
        let mutation = yield* store.mutation(identity);
        yield* yieldUntil(() => entryCalls === 1);
        for (let i = 0; i < 20 && mutation === "pending"; i++) {
          yield* Effect.yieldNow;
          mutation = yield* store.mutation(identity);
        }
        expect(mutation).toBe("blocked");
        expect(reads).toBe(0);
        expect(entryCalls).toBe(1);
      }),
  );

  it.effect("a settled write lifts the fence even after a refusal or an abandoned waiter", () =>
    Effect.gen(function* () {
      let refuse = true;
      const completion = Promise.withResolvers<void>();
      let password: string | undefined = "stored-grant";
      let slow = false;
      const factory: KeychainEntryFactory = () =>
        Promise.resolve({
          getPassword: () => Promise.resolve(password),
          setPassword: (value) => {
            if (refuse) return Promise.reject(new Error("user denied Keychain access"));
            if (slow)
              return completion.promise.then(() => {
                password = value;
              });
            password = value;
            return Promise.resolve();
          },
          deleteCredential: () => Promise.resolve(true),
        });
      const store = yield* makeKeychainStore({ entryFactory: factory, timeoutMs: 100 });
      // A refused write leaves the old value, which reads may use again at once.
      expect(yield* store.write(identity, "new-grant").pipe(Effect.isFailure)).toBe(true);
      expect(yield* store.mutation(identity)).toBe("idle");
      expect(yield* store.read(identity)).toBe("stored-grant");
      // A write outliving its waiter's deadline lifts the fence once it settles.
      refuse = false;
      slow = true;
      const saving = yield* store
        .write(identity, "late-grant")
        .pipe(Effect.result, Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(101);
      expect((yield* Fiber.join(saving))._tag).toBe("Failure");
      expect(yield* store.read(identity).pipe(Effect.isFailure)).toBe(true);
      completion.resolve();
      yield* yieldUntil(() => password === "late-grant");
      let mutation = yield* store.mutation(identity);
      for (let i = 0; i < 20 && mutation !== "idle"; i++) {
        yield* Effect.yieldNow;
        mutation = yield* store.mutation(identity);
      }
      expect(mutation).toBe("idle");
      expect(yield* store.read(identity)).toBe("late-grant");
    }),
  );

  it.effect("normalizes either native absence value without losing later stored credentials", () =>
    Effect.gen(function* () {
      for (const missing of [null, undefined]) {
        const store = yield* makeKeychainStore({
          entryFactory: memoryKeychain(undefined, missing).factory,
        });
        expect(yield* store.read(identity)).toBeUndefined();
        yield* store.write(identity, "private-grant");
        expect(yield* store.read(identity)).toBe("private-grant");
        yield* store.remove(identity);
        expect(yield* store.read(identity)).toBeUndefined();
      }
    }),
  );
  it.effect(
    "rejects a stale native read even when its concurrent replacement already settled",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const read = Promise.withResolvers<string | undefined>();
        let first = true;
        let password = "old-grant";
        const factory: KeychainEntryFactory = () =>
          Promise.resolve({
            getPassword: () => {
              if (!first) return Promise.resolve(password);
              first = false;
              Deferred.doneUnsafe(entered, Effect.void);
              return read.promise;
            },
            setPassword: (value) => {
              password = value;
              return Promise.resolve();
            },
            deleteCredential: () => Promise.resolve(true),
          });
        const store = yield* makeKeychainStore({ entryFactory: factory });
        const loading = yield* store.read(identity).pipe(Effect.result, Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* store.write(identity, "new-grant");
        read.resolve("old-grant");
        expect((yield* Fiber.join(loading))._tag).toBe("Failure");
        expect(yield* store.read(identity)).toBe("new-grant");
      }),
  );
  it.effect(
    "retains cancelled writes across service replacement and deletes only after native settlement",
    () =>
      Effect.gen(function* () {
        const native = yield* heldKeychain();
        const first = yield* makeKeychainStore({ entryFactory: native.factory });
        const write = yield* first.write(identity, "private-grant").pipe(Effect.forkScoped);
        yield* Deferred.await(native.entered);
        yield* Fiber.interrupt(write);
        const replacement = yield* makeKeychainStore({ entryFactory: native.factory });
        expect(yield* replacement.read(identity).pipe(Effect.isFailure)).toBe(true);
        expect(yield* replacement.write(identity, "another").pipe(Effect.isFailure)).toBe(true);
        const deletion = yield* replacement.remove(identity).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        expect(native.deleted()).toBe(false);
        native.release();
        yield* Fiber.join(deletion);
        expect(native.deleted()).toBe(true);
        expect(yield* replacement.read(identity)).toBeUndefined();
      }),
  );
  it.effect(
    "keeps failed deletion unavailable and supports explicit retry without claiming removal",
    () =>
      Effect.gen(function* () {
        let fail = true;
        let password: string | undefined = "private-grant";
        const factory: KeychainEntryFactory = () =>
          Promise.resolve({
            getPassword: () => Promise.resolve(password),
            setPassword: (value) => {
              password = value;
              return Promise.resolve();
            },
            deleteCredential: () => {
              if (fail) return Promise.reject(new Error("secret-account-and-token"));
              password = undefined;
              return Promise.resolve(true);
            },
          });
        const store = yield* makeKeychainStore({ entryFactory: factory });
        const failed = yield* store.remove(identity).pipe(Effect.result);
        expect(failed._tag).toBe("Failure");
        expect(failed._tag === "Failure" && failed.failure.message).not.toContain("secret-account");
        expect(yield* store.read(identity).pipe(Effect.isFailure)).toBe(true);
        fail = false;
        yield* store.remove(identity);
        expect(yield* store.read(identity)).toBeUndefined();
      }),
  );
  it.effect("does not create native entries until an actual read or mutation", () =>
    Effect.gen(function* () {
      let opened = false;
      const store = yield* makeKeychainStore({
        entryFactory: () => {
          opened = true;
          return Promise.reject(new Error("unavailable"));
        },
      });
      expect(opened).toBe(false);
      expect(yield* store.read(identity).pipe(Effect.isFailure)).toBe(true);
      expect(opened).toBe(true);
    }),
  );
});

// Explicit opt-in only. This creates one disposable UUID namespace and one entry,
// then deletes that exact entry in a finalizer. It never enumerates Keychain.
it.live("round-trips a disposable macOS Keychain grant only when explicitly enabled", () =>
  Effect.gen(function* () {
    const enabled = yield* Config.String("PI_MCP_KEYCHAIN_INTEGRATION").pipe(
      Config.withDefault("0"),
    );
    if (enabled !== "1" || process.platform !== "darwin") return;
    const crypto = yield* Crypto.Crypto;
    const uuid = yield* crypto.randomUUIDv4;
    const service = `com.cosmic-pi.mcp.test.${uuid}`;
    const store = yield* makeKeychainStore({ service });
    expect(yield* store.read(identity)).toBeUndefined();
    // A failed or interrupted write can still own a pending native mutation.
    // Install deletion first so cleanup joins it even when the first write fails.
    yield* Effect.addFinalizer(() =>
      store.remove(identity).pipe(
        Effect.tapError(() =>
          Effect.logError(
            `Disposable Keychain cleanup failed: service=${service} identity=${identity}`,
          ),
        ),
        Effect.orDie,
      ),
    );
    yield* store.write(identity, `disposable-${uuid}`);
    expect(yield* store.read(identity)).toBe(`disposable-${uuid}`);
    yield* store.write(identity, `replacement-${uuid}`);
    expect(yield* store.read(identity)).toBe(`replacement-${uuid}`);
    yield* store.remove(identity);
    expect(yield* store.read(identity)).toBeUndefined();
  }).pipe(Effect.provide(NodeCrypto.layer)),
);
