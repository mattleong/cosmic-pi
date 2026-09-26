import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { bestEffortHostBootstrap } from "../src/runtime/host-bootstrap.ts";
import { deferredPromise } from "../testing.ts";

it.effect("contains rejected and synchronously throwing host prerequisites", () =>
  Effect.gen(function* () {
    let calls = 0;
    yield* bestEffortHostBootstrap("preview-settings.reject", () => {
      calls += 1;
      return Promise.reject(new Error("sensitive host failure"));
    });
    yield* bestEffortHostBootstrap("preview-settings.throw", () => {
      calls += 1;
      throw new Error("sensitive synchronous failure");
    });
    // Deliberately hostile PromiseLike fixture; a Proxy keeps the object non-thenable at rest.
    // SAFETY: The Proxy handler below supplies the `then` member this assertion promises.
    const hostileThenable = new Proxy({} as PromiseLike<void>, {
      get: (_target, property) =>
        property === "then"
          ? () => {
              calls += 1;
              throw new Error("sensitive thenable failure");
            }
          : undefined,
    });
    yield* bestEffortHostBootstrap("preview-settings.thenable", () => hostileThenable);
    expect(calls).toBe(3);
  }),
);

it.effect("waits for a successful host startup prerequisite", () =>
  Effect.gen(function* () {
    let loaded = false;
    yield* bestEffortHostBootstrap("preview-settings", () =>
      Promise.resolve().then(() => {
        loaded = true;
      }),
    );
    expect(loaded).toBe(true);
  }),
);

it.effect("detaches a non-cancellable Promise when startup is interrupted", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    // A non-cancellable host Promise that only settles after the interruption assertion.
    const lateSettlement = deferredPromise();
    let cancellationSignal: AbortSignal | undefined;
    const bootstrap = yield* bestEffortHostBootstrap("preview-settings", (signal) => {
      cancellationSignal = signal;
      Deferred.doneUnsafe(started, Effect.void);
      return lateSettlement.promise;
    }).pipe(Effect.forkChild({ startImmediately: true }));

    yield* Deferred.await(started);
    yield* Fiber.interrupt(bootstrap);
    expect(cancellationSignal?.aborted).toBe(true);
    lateSettlement.resolve();
  }),
);
