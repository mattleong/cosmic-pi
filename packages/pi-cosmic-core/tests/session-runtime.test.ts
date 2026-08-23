// Pi lifecycle characterization intentionally exercises AbortController.
// Test-only runtime driver captures the host-boundary startup span.
import * as Predicate from "effect/Predicate";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  makePiManagedRuntime,
  makePiSessionRuntimeSlot,
  PiSessionRuntimeError,
  type PiManagedRuntime,
  type PiSessionRuntimeSlot,
} from "../index.ts";
import { makeCapturedTracer } from "../testing.ts";

function makeAbortDisposalHarness() {
  const events: string[] = [];
  const startedGate = Deferred.makeUnsafe<void>();
  const disposalGate = Deferred.makeUnsafe<void>();
  const started = Effect.runPromise(Deferred.await(startedGate));
  const disposal = Effect.runPromise(Deferred.await(disposalGate));
  const slot = makePiSessionRuntimeSlot<number, never, never, never>({
    makeRuntime: (input): PiManagedRuntime<never, never> => ({
      run: (_effect, signal) => {
        events.push(`run:${input}`);
        if (input !== 1) {
          // SAFETY: This harness invokes run only with Effect<void>; its resolved value is therefore undefined.
          return Promise.resolve(undefined as never);
        }
        Deferred.doneUnsafe(startedGate, Effect.void);
        // Settles only through abort-driven interruption, like the replaced host runtime.
        return Effect.runPromise(Effect.never, signal ? { signal } : undefined);
      },
      fork: () => {
        throw new Error("unused");
      },
      runSync: () => {
        throw new Error("unused");
      },
      dispose: () => {
        events.push(`dispose:${input}`);
        return input === 1 ? disposal : Promise.resolve();
      },
    }),
    startup: () => Effect.void,
  });
  const releaseDisposal = () => void Deferred.doneUnsafe(disposalGate, Effect.void);
  return { disposal, events, releaseDisposal, slot, started };
}

function makeHostileSignal(operation: "addEventListener" | "aborted"): AbortSignal {
  const target = new AbortController().signal;
  return new Proxy(target, {
    get(signal, property) {
      if (property === operation) throw new Error(`hostile ${operation}`);
      // SAFETY: The `in` check proves this proxy property belongs to the AbortSignal contract.
      const value = property in signal ? signal[property as keyof AbortSignal] : undefined;
      return Predicate.isFunction(value) ? value.bind(signal) : value;
    },
  });
}

function makeSignalSetupHarness(signal: AbortSignal) {
  let disposals = 0;
  let failures = 0;
  let runs = 0;
  const slot = makePiSessionRuntimeSlot<void, never, never, never>({
    makeRuntime: (): PiManagedRuntime<never, never> => ({
      run: () => {
        runs++;
        // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
        return Promise.resolve(undefined as never);
      },
      fork: () => {
        throw new Error("unused");
      },
      runSync: () => {
        throw new Error("unused");
      },
      dispose: () => {
        disposals++;
        return Promise.resolve();
      },
    }),
    startup: () => Effect.void,
    onStartFailure: () => {
      failures++;
    },
  });
  return { counts: () => ({ disposals, failures, runs }), signal, slot };
}

it.effect("replaces a stalled runtime and releases every acquired layer exactly once", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const activations: number[] = [];
    const firstStarted = yield* Deferred.make<void>();
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const pi = {} as ExtensionAPI;
    const slot = makePiSessionRuntimeSlot<number, never, never, never>({
      makeRuntime: (input) =>
        makePiManagedRuntime(
          pi,
          Layer.effectDiscard(
            Effect.acquireRelease(
              Effect.sync(() => events.push(`acquire:${input}`)),
              () => Effect.sync(() => events.push(`release:${input}`)),
            ),
          ),
        ),
      startup: (input) =>
        input === 1
          ? Effect.sync(() => undefined).pipe(
              Effect.andThen(Deferred.succeed(firstStarted, undefined)),
              Effect.andThen(Effect.never),
            )
          : Effect.void,
      onActivated: (input) => void activations.push(input),
    });

    const first = slot.start(1);
    yield* Deferred.await(firstStarted);
    const second = slot.start(2);
    const tokens = yield* Effect.promise(() => Promise.all([first, second]));
    expect(tokens[0]).toBeUndefined();
    expect(tokens[1]).toBe(2);
    expect(events).toEqual(["acquire:1", "release:1", "acquire:2"]);
    expect(activations).toEqual([2]);

    yield* Effect.promise(() => slot.shutdown());
    yield* Effect.promise(() => slot.shutdown());
    expect(events).toEqual(["acquire:1", "release:1", "acquire:2", "release:2"]);
  }),
);

it.effect("captures a stable runtime startup span without session input", () =>
  Effect.gen(function* () {
    const captured = makeCapturedTracer();
    const slot = makePiSessionRuntimeSlot<string, never, never, never>({
      makeRuntime: () =>
        makePiManagedRuntime(
          // SAFETY: This locally constructed test fixture satisfies the host contract used here.
          {} as ExtensionAPI,
          captured.layer,
        ),
      startup: () => Effect.void,
    });
    expect(yield* Effect.promise(() => slot.start("secret-session-input"))).toBe(1);
    expect(captured.spans.map((span) => span.name)).toContain("pi-cosmic-core.runtime.startup");
    expect(captured.spans.map((span) => span.name).join(" ")).not.toContain("secret-session-input");
    yield* Effect.promise(() => slot.shutdown());
  }),
);

it.effect("publishes startup values only after activation", () =>
  Effect.gen(function* () {
    const startupEntered = yield* Deferred.make<void>();
    const releaseStartup = yield* Deferred.make<void>();
    const activations: Array<readonly [number, string]> = [];
    const slot = makePiSessionRuntimeSlot<void, never, never, never, string>({
      makeRuntime: () =>
        makePiManagedRuntime(
          // SAFETY: This locally constructed test fixture satisfies the host contract used here.
          {} as ExtensionAPI,
          Layer.empty,
        ),
      startup: () =>
        Deferred.succeed(startupEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseStartup)),
          Effect.as("ready"),
        ),
      onActivated: (_input, token, value) => void activations.push([token, value]),
    });

    const starting = slot.start(undefined);
    yield* Deferred.await(startupEntered);
    expect(slot.isActive()).toBe(false);
    expect(slot.isCurrent(1)).toBe(false);
    expect(slot.fork(Effect.void)).toBeDefined();
    yield* Deferred.succeed(releaseStartup, undefined);
    expect(yield* Effect.promise(() => starting)).toBe(1);
    expect(slot.isActive()).toBe(true);
    expect(slot.isCurrent(1)).toBe(true);
    expect(activations).toEqual([[1, "ready"]]);
    yield* Effect.promise(() => slot.shutdown());
  }),
);

it.effect("rechecks ownership after reentrant activation teardown", () =>
  Effect.gen(function* () {
    let shutdown: Promise<void> | undefined;
    let slot: PiSessionRuntimeSlot<void, never, never>;
    slot = makePiSessionRuntimeSlot<void, never, never, never>({
      makeRuntime: () =>
        makePiManagedRuntime(
          // SAFETY: This locally constructed test fixture satisfies the host contract used here.
          {} as ExtensionAPI,
          Layer.empty,
        ),
      startup: () => Effect.void,
      onActivated: () => {
        shutdown = slot.shutdown();
      },
    });

    expect(yield* Effect.promise(() => slot.start(undefined))).toBeUndefined();
    expect(slot.isActive()).toBe(false);
    const cleanup = shutdown;
    if (cleanup) yield* Effect.promise(() => cleanup);
  }),
);

it.effect("releases acquired resources after startup failure", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const failures: number[] = [];
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const slot = makePiSessionRuntimeSlot<void, never, "startup", never>({
      makeRuntime: () =>
        makePiManagedRuntime(
          {} as ExtensionAPI,
          Layer.effectDiscard(
            Effect.acquireRelease(
              Effect.sync(() => events.push("acquire")),
              () => Effect.sync(() => events.push("release")),
            ),
          ),
        ),
      startup: () => Effect.fail("startup" as const),
      onStartFailure: (_input, token) => failures.push(token),
    });
    expect(yield* Effect.promise(() => slot.start(undefined))).toBeUndefined();
    expect(events).toEqual(["acquire", "release"]);
    expect(failures).toEqual([1]);
  }),
);

it.effect("reports a synchronous runtime-construction throw without activating the slot", () =>
  Effect.gen(function* () {
    const failures: number[] = [];
    const slot = makePiSessionRuntimeSlot<void, never, never, never>({
      makeRuntime: () => {
        throw new Error("hostile runtime constructor");
      },
      startup: () => Effect.void,
      onStartFailure: (_input, token) => void failures.push(token),
    });

    expect(yield* Effect.promise(() => slot.start(undefined))).toBeUndefined();
    expect(failures).toEqual([1]);
    expect((yield* Effect.result(Effect.tryPromise(() => slot.run(Effect.void))))._tag).toBe(
      "Failure",
    );
  }),
);

for (const operation of ["startup", "run"] as const) {
  it.effect(`disposes the runtime when ${operation} throws synchronously`, () =>
    Effect.gen(function* () {
      let disposals = 0;
      let runs = 0;
      const failures: number[] = [];
      const runtime: PiManagedRuntime<never, never> = {
        run: () => {
          runs++;
          if (operation === "run") throw new Error("hostile runtime.run");
          // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
          return Promise.resolve(undefined as never);
        },
        fork: () => {
          throw new Error("unused");
        },
        runSync: () => {
          throw new Error("unused");
        },
        dispose: () => {
          disposals++;
          return Promise.resolve();
        },
      };
      const slot = makePiSessionRuntimeSlot<void, never, never, never>({
        makeRuntime: () => runtime,
        startup: () => {
          if (operation === "startup") throw new Error("hostile startup constructor");
          return Effect.void;
        },
        onStartFailure: (_input, token) => void failures.push(token),
      });

      expect(yield* Effect.promise(() => slot.start(undefined))).toBeUndefined();
      expect({ disposals, failures, runs }).toEqual({
        disposals: 1,
        failures: [1],
        runs: operation === "run" ? 1 : 0,
      });
      expect((yield* Effect.result(Effect.tryPromise(() => slot.run(Effect.void))))._tag).toBe(
        "Failure",
      );
    }),
  );
}

it.effect("disposes an already-aborted start and leaves the slot unavailable", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const controller = new AbortController();
    controller.abort();
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const slot = makePiSessionRuntimeSlot<void, never, never, never>({
      makeRuntime: () =>
        makePiManagedRuntime(
          {} as ExtensionAPI,
          Layer.effectDiscard(
            Effect.acquireRelease(
              Effect.sync(() => events.push("acquire")),
              () => Effect.sync(() => events.push("release")),
            ),
          ),
        ),
      startup: () => Effect.void,
    });
    expect(yield* Effect.promise(() => slot.start(undefined, controller.signal))).toBeUndefined();
    const result = yield* Effect.result(
      Effect.tryPromise({
        try: () => slot.run(Effect.void),
        catch: (error) =>
          error instanceof PiSessionRuntimeError
            ? error
            : new PiSessionRuntimeError({ operation: "test", message: "unexpected" }),
      }),
    );
    expect(result._tag).toBe("Failure");
    expect(events).toEqual([]);
  }),
);

for (const operation of ["addEventListener", "aborted"] as const) {
  it.effect(`disposes the runtime when AbortSignal.${operation} throws`, () =>
    Effect.gen(function* () {
      const harness = makeSignalSetupHarness(makeHostileSignal(operation));
      expect(
        yield* Effect.promise(() => harness.slot.start(undefined, harness.signal)),
      ).toBeUndefined();
      expect(harness.counts()).toEqual({ disposals: 1, failures: 1, runs: 0 });

      const result = yield* Effect.result(
        Effect.tryPromise({
          try: () => harness.slot.run(Effect.void),
          catch: (error) =>
            error instanceof PiSessionRuntimeError
              ? error
              : new PiSessionRuntimeError({ operation: "test", message: "unexpected" }),
        }),
      );
      expect(result._tag).toBe("Failure");
      yield* Effect.promise(() => harness.slot.shutdown());
      expect(harness.counts()).toEqual({ disposals: 1, failures: 1, runs: 0 });
    }),
  );
}

it.effect("waits for aborted runtime disposal before starting a replacement", () =>
  Effect.gen(function* () {
    const harness = makeAbortDisposalHarness();
    const controller = new AbortController();
    const first = harness.slot.start(1, controller.signal);
    yield* Effect.promise(() => harness.started);
    controller.abort();
    expect(yield* Effect.promise(() => first)).toBeUndefined();

    let replacementSettled = false;
    const replacement = harness.slot.start(2).then((token) => {
      replacementSettled = true;
      return token;
    });
    yield* Effect.promise(() => Promise.resolve());
    expect(replacementSettled).toBe(false);
    expect(harness.events).not.toContain("run:2");

    harness.releaseDisposal();
    expect(yield* Effect.promise(() => replacement)).toBe(3);
    expect(harness.events).toEqual(["run:1", "dispose:1", "run:2"]);
    yield* Effect.promise(() => harness.slot.shutdown());
  }),
);

it.effect("waits for aborted runtime disposal before shutdown resolves", () =>
  Effect.gen(function* () {
    const harness = makeAbortDisposalHarness();
    const controller = new AbortController();
    const first = harness.slot.start(1, controller.signal);
    yield* Effect.promise(() => harness.started);
    controller.abort();
    expect(yield* Effect.promise(() => first)).toBeUndefined();

    let shutdownSettled = false;
    const shutdown = harness.slot.shutdown().then(() => {
      shutdownSettled = true;
    });
    yield* Effect.promise(() => Promise.resolve());
    expect(shutdownSettled).toBe(false);

    harness.releaseDisposal();
    yield* Effect.promise(() => shutdown);
    expect(shutdownSettled).toBe(true);
    expect(harness.events).toEqual(["run:1", "dispose:1"]);
  }),
);
