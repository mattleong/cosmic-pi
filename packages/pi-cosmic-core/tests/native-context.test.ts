import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberHandle from "effect/FiberHandle";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { describe, expect, vi } from "vitest";
import { makeNativeContext, NativeContextError } from "../src/platform/native-context.ts";
import * as NodeBuiltins from "../src/platform/node-builtins.ts";

// Test-only Promise boundary. Each gate waiter belongs to the caller's scope.
const makeNativePromiseGate = Effect.gen(function* () {
  const deferred = yield* Deferred.make<void>();
  const runPromise = yield* FiberHandle.makeRuntimePromise<never, void, never>();
  const promise = runPromise(Deferred.await(deferred));
  void promise.catch(() => undefined);
  return { promise, open: Deferred.succeed(deferred, undefined) };
});

interface CallbackOwner {
  readonly id: string;
}

describe("scoped native callback context", () => {
  it.live("isolates interleaved async callbacks without leaking to their caller", () =>
    Effect.gen(function* () {
      const context = yield* makeNativeContext<CallbackOwner>();
      const first = { id: "first" };
      const second = { id: "second" };
      const resumeFirst = yield* makeNativePromiseGate;
      const resumeSecond = yield* makeNativePromiseGate;
      const start = (value: CallbackOwner, resume: Promise<void>) =>
        context.run(value, () => {
          expect(context.current()).toBe(value);
          return resume.then(() => {
            expect(context.current()).toBe(value);
            return Promise.resolve().then(() => context.current());
          });
        });
      const pendingFirst = start(first, resumeFirst.promise);
      const pendingSecond = start(second, resumeSecond.promise);
      expect(context.current()).toBeUndefined();
      yield* resumeSecond.open;
      expect(yield* Effect.promise(() => pendingSecond)).toBe(second);
      expect(context.current()).toBeUndefined();
      yield* resumeFirst.open;
      expect(yield* Effect.promise(() => pendingFirst)).toBe(first);
      expect(context.current()).toBeUndefined();
    }),
  );

  it.live("cancels native gate waits with their owner without cancelling another scope", () =>
    Effect.gen(function* () {
      const owner = yield* Scope.fork(yield* Effect.scope);
      const context = yield* makeNativeContext<string>().pipe(
        Effect.provideService(Scope.Scope, owner),
      );
      const gate = yield* makeNativePromiseGate.pipe(Effect.provideService(Scope.Scope, owner));
      const other = yield* makeNativePromiseGate;
      let resumed = false;
      const pending = context.run("closing", () =>
        gate.promise.then(() => {
          resumed = true;
        }),
      );
      const settled = pending.then(
        () => "opened",
        () => "cancelled",
      );
      yield* Scope.close(owner, Exit.void);
      expect(yield* Effect.promise(() => settled)).toBe("cancelled");
      expect(resumed).toBe(false);
      expect(context.current()).toBeUndefined();
      yield* other.open;
      yield* Effect.promise(() => other.promise);
    }),
  );

  it.live("restores the parent after nested returns and synchronous throws", () =>
    Effect.gen(function* () {
      const context = yield* makeNativeContext<string>();
      const failure = new Error("callback failure");
      const result = context.run("parent", () => {
        expect(context.run("child", () => context.current())).toBe("child");
        expect(context.current()).toBe("parent");
        expect(() =>
          context.run("throwing child", () => {
            expect(context.current()).toBe("throwing child");
            throw failure;
          }),
        ).toThrow(failure);
        expect(context.current()).toBe("parent");
        return 42;
      });
      expect(result).toBe(42);
      expect(context.current()).toBeUndefined();
      expect(() =>
        context.run("throwing root", () => {
          throw failure;
        }),
      ).toThrow(failure);
      expect(context.current()).toBeUndefined();
    }),
  );

  it.live("preserves Promise identity and rejection while restoring parent context", () =>
    Effect.gen(function* () {
      const context = yield* makeNativeContext<string>();
      const failure = new Error("async callback failure");
      const pending = context.run("parent", () => {
        const rejected = Promise.reject(failure);
        expect(context.run("child", () => rejected)).toBe(rejected);
        return rejected.catch((error: Error) => {
          expect(error).toBe(failure);
          expect(context.current()).toBe("parent");
          return context
            .run("child", () =>
              Promise.resolve().then(() => {
                expect(context.current()).toBe("child");
                throw failure;
              }),
            )
            .catch((childError: Error) => {
              expect(childError).toBe(failure);
              expect(context.current()).toBe("parent");
            });
        });
      });
      expect(context.current()).toBeUndefined();
      yield* Effect.promise(() => pending);
      expect(context.current()).toBeUndefined();
    }),
  );

  it.live("retains each callback's provenance after both outer Promises settle", () =>
    Effect.gen(function* () {
      const context = yield* makeNativeContext<string>();
      const first = yield* makeNativePromiseGate;
      const second = yield* makeNativePromiseGate;
      const callbacks: Promise<string | undefined>[] = [];
      const send = (value: string, resume: Promise<void>) =>
        context.run(value, () => {
          callbacks.push(resume.then(() => context.current()));
          return Promise.resolve();
        });
      yield* Effect.promise(() =>
        Promise.all([send("first", first.promise), send("second", second.promise)]),
      );
      expect(context.current()).toBeUndefined();
      yield* second.open;
      expect(yield* Effect.promise(() => callbacks[1]!)).toBe("second");
      yield* first.open;
      expect(yield* Effect.promise(() => callbacks[0]!)).toBe("first");
      expect(context.current()).toBeUndefined();
    }),
  );

  it.live("withdraws late callback context and blocks reuse after scope closure", () =>
    Effect.gen(function* () {
      const owner = yield* Scope.fork(yield* Effect.scope);
      const context = yield* makeNativeContext<string>().pipe(
        Effect.provideService(Scope.Scope, owner),
      );
      const resume = yield* makeNativePromiseGate;
      const callback = vi.fn();
      const late = context.run("closed", () =>
        resume.promise.then(() => {
          expect(context.current()).toBeUndefined();
          expect(() => context.run("reused", callback)).toThrow(NativeContextError);
        }),
      );
      yield* Scope.close(owner, Exit.void);
      yield* Scope.close(owner, Exit.void);
      expect(context.current()).toBeUndefined();
      expect(() => context.run("reused", callback)).toThrow(NativeContextError);
      yield* resume.open;
      yield* Effect.promise(() => late);
      expect(callback).not.toHaveBeenCalled();
      expect(context.current()).toBeUndefined();
    }),
  );

  it.live("isolates separately owned contexts and preserves a live replacement", () =>
    Effect.gen(function* () {
      const owner = yield* Scope.fork(yield* Effect.scope);
      const old = yield* makeNativeContext<string>().pipe(
        Effect.provideService(Scope.Scope, owner),
      );
      const replacement = yield* makeNativeContext<string>();
      const resume = yield* makeNativePromiseGate;
      const late = old.run("old", () =>
        replacement.run("replacement", () => {
          expect(old.current()).toBe("old");
          expect(replacement.current()).toBe("replacement");
          return resume.promise.then(() => {
            expect(old.current()).toBeUndefined();
            expect(replacement.current()).toBe("replacement");
          });
        }),
      );
      yield* Scope.close(owner, Exit.void);
      yield* resume.open;
      yield* Effect.promise(() => late);
      expect(old.current()).toBeUndefined();
      expect(replacement.current()).toBeUndefined();
    }),
  );

  it.live("redacts unavailable native acquisition without manufacturing a fallback", () =>
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          vi.spyOn(NodeBuiltins, "nodeCreateAsyncLocalStorage").mockImplementation(() => {
            throw new Error("secret-native-diagnostic");
          }),
        ),
        (spy) => Effect.sync(() => spy.mockRestore()),
      );
      const error = yield* makeNativeContext<string>().pipe(Effect.flip);
      expect(error).toBeInstanceOf(NativeContextError);
      expect(error.operation).toBe("acquire");
      expect(String(error)).not.toContain("secret-native-diagnostic");
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(NativeContextError))(error);
      expect(encoded).not.toContain("secret-native-diagnostic");
    }),
  );

  it.live("revokes authority before native cleanup, even when cleanup throws", () =>
    Effect.gen(function* () {
      const create = NodeBuiltins.nodeCreateAsyncLocalStorage;
      const duringDisable = vi.fn<() => void>();
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          vi.spyOn(NodeBuiltins, "nodeCreateAsyncLocalStorage").mockImplementation(<A>() => {
            const storage = create<A>();
            const disable = storage.disable.bind(storage);
            storage.disable = () => {
              duringDisable();
              disable();
              throw new Error("secret-cleanup-diagnostic");
            };
            return storage;
          }),
        ),
        (spy) => Effect.sync(() => spy.mockRestore()),
      );
      const owner = yield* Scope.fork(yield* Effect.scope);
      const context = yield* makeNativeContext<string>().pipe(
        Effect.provideService(Scope.Scope, owner),
      );
      let currentDuringDisable: string | undefined = "not observed";
      let runError: unknown;
      duringDisable.mockImplementation(() => {
        currentDuringDisable = context.current();
        try {
          context.run("reused", () => undefined);
        } catch (error) {
          runError = error;
        }
      });
      yield* Scope.close(owner, Exit.void);
      yield* Scope.close(owner, Exit.void);
      expect(duringDisable).toHaveBeenCalledOnce();
      expect(currentDuringDisable).toBeUndefined();
      expect(runError).toBeInstanceOf(NativeContextError);
      expect(context.current()).toBeUndefined();
      expect(() => context.run("reused", () => undefined)).toThrow(NativeContextError);
    }),
  );
});
