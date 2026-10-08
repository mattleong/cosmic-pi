// Pi lifecycle characterization intentionally exercises AbortController.
// Test-only runtime driver captures the host-boundary startup span.
import * as Predicate from "effect/Predicate";

import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vitest";
import {
  makePiManagedRuntime,
  makePiSessionRuntimeSlot,
  type PiManagedRuntime,
  type PiSessionRuntimeSlot,
} from "../index.ts";
import {
  extensionApiFixture,
  macrotask,
  makeCapturedTracer,
  makeLifecycleProbe,
} from "../testing.ts";

/** A fake managed runtime whose unused `fork` fails loudly. */
const fakeRuntime = (
  run: PiManagedRuntime<never, never>["run"],
  dispose: () => Promise<void>,
): PiManagedRuntime<never, never> => ({
  run,
  fork: () => {
    throw new Error("unused");
  },
  dispose,
});

const hostRuntime = <R, E>(layer: Layer.Layer<R, E>) =>
  makePiManagedRuntime(extensionApiFixture({}), layer);

const rejects = <A>(run: () => Promise<A>) =>
  Effect.promise(() =>
    run().then(
      () => false,
      () => true,
    ),
  );

/** Starts input 1, aborts it while startup stalls, and holds its runtime disposal until released. */
function abortStalledStart() {
  const events: string[] = [];
  const startedGate = Deferred.makeUnsafe<void>();
  const disposalGate = Deferred.makeUnsafe<void>();
  const started = Effect.runPromise(Deferred.await(startedGate));
  const disposal = Effect.runPromise(Deferred.await(disposalGate));
  const slot = makePiSessionRuntimeSlot<number, never, never, never>({
    makeRuntime: (input) =>
      fakeRuntime(
        (_effect, signal) => {
          events.push(`run:${input}`);
          if (input !== 1) {
            // SAFETY: This harness invokes run only with Effect<void>; its resolved value is therefore undefined.
            return Promise.resolve(undefined as never);
          }
          Deferred.doneUnsafe(startedGate, Effect.void);
          // Settles only through abort-driven interruption, like the replaced host runtime.
          return Effect.runPromise(Effect.never, signal ? { signal } : undefined);
        },
        () => {
          events.push(`dispose:${input}`);
          return input === 1 ? disposal : Promise.resolve();
        },
      ),
    startup: () => Effect.void,
  });
  const releaseDisposal = () => void Deferred.doneUnsafe(disposalGate, Effect.void);
  const controller = new AbortController();
  return Effect.gen(function* () {
    const first = slot.start(1, controller.signal);
    yield* Effect.promise(() => started);
    controller.abort();
    expect(yield* Effect.promise(() => first)).toBeUndefined();
    return { events, releaseDisposal, slot };
  });
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

/** A counting slot whose startup or runtime `run` throws synchronously when `fail` names it. */
function makeCountingSlot(fail: string) {
  let disposals = 0;
  const failures: number[] = [];
  let runs = 0;
  const slot = makePiSessionRuntimeSlot<void, never, never, never>({
    makeRuntime: () =>
      fakeRuntime(
        () => {
          runs++;
          if (fail === "run") throw new Error("hostile runtime.run");
          // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
          return Promise.resolve(undefined as never);
        },
        () => {
          disposals++;
          return Promise.resolve();
        },
      ),
    startup: () => {
      if (fail === "startup") throw new Error("hostile startup constructor");
      return Effect.void;
    },
    onStartFailure: (_input, token) => void failures.push(token),
  });
  return { counts: () => ({ disposals, failures: [...failures], runs }), slot };
}

it.effect("replaces a stalled runtime and releases every acquired layer exactly once", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const activations: number[] = [];
    const firstStarted = yield* Deferred.make<void>();
    const slot = makePiSessionRuntimeSlot<number, never, never, never>({
      makeRuntime: (input) =>
        hostRuntime(
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
      makeRuntime: () => hostRuntime(captured.layer),
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
      makeRuntime: () => hostRuntime(Layer.empty),
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
      makeRuntime: () => hostRuntime(Layer.empty),
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
    const probe = makeLifecycleProbe("acquire", "release");
    const failures: number[] = [];
    const slot = makePiSessionRuntimeSlot<void, never, "startup", never>({
      makeRuntime: () => hostRuntime(probe.layer),
      startup: () => Effect.fail("startup" as const),
      onStartFailure: (_input, token) => failures.push(token),
    });
    expect(yield* Effect.promise(() => slot.start(undefined))).toBeUndefined();
    expect(probe.events).toEqual(["acquire", "release"]);
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
    expect(yield* rejects(() => slot.run(Effect.void))).toBe(true);
  }),
);

for (const [failure, runs] of [
  ["startup", 0],
  ["run", 1],
  ["addEventListener", 0],
  ["aborted", 0],
] as const) {
  it.effect(`disposes the runtime once when ${failure} throws during start`, () =>
    Effect.gen(function* () {
      const signal =
        failure === "addEventListener" || failure === "aborted"
          ? makeHostileSignal(failure)
          : undefined;
      const { counts, slot } = makeCountingSlot(failure);
      expect(yield* Effect.promise(() => slot.start(undefined, signal))).toBeUndefined();
      expect(counts()).toEqual({ disposals: 1, failures: [1], runs });
      expect(yield* rejects(() => slot.run(Effect.void))).toBe(true);
      yield* Effect.promise(() => slot.shutdown());
      expect(counts()).toEqual({ disposals: 1, failures: [1], runs });
    }),
  );
}

it.effect("disposes an already-aborted start and leaves the slot unavailable", () =>
  Effect.gen(function* () {
    const probe = makeLifecycleProbe("acquire", "release");
    const controller = new AbortController();
    controller.abort();
    const slot = makePiSessionRuntimeSlot<void, never, never, never>({
      makeRuntime: () => hostRuntime(probe.layer),
      startup: () => Effect.void,
    });
    expect(yield* Effect.promise(() => slot.start(undefined, controller.signal))).toBeUndefined();
    expect(yield* rejects(() => slot.run(Effect.void))).toBe(true);
    expect(probe.events).toEqual([]);
  }),
);

/** A real host-runtime slot whose startup stalls until interrupted; counts interruptions and hooks. */
const stalledSlot = Effect.gen(function* () {
  const started = yield* Deferred.make<void>();
  let interruptions = 0;
  let settlements = 0;
  const slot = makePiSessionRuntimeSlot<void, never, never, never>({
    makeRuntime: () => hostRuntime(Layer.empty),
    startup: () =>
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Effect.sync(() => void interruptions++)),
      ),
    onActivated: () => void settlements++,
    onStartFailure: () => void settlements++,
  });
  return { slot, started, counts: () => ({ interruptions, settlements }) };
});

it.effect("host abort interrupts a stalled startup once, silently, and removes its listener", () =>
  Effect.gen(function* () {
    const { slot, started, counts } = yield* stalledSlot;
    const controller = new AbortController();
    const addEventListener = vi.spyOn(controller.signal, "addEventListener");
    const removeEventListener = vi.spyOn(controller.signal, "removeEventListener");
    const startup = slot.start(undefined, controller.signal);
    yield* Deferred.await(started);

    controller.abort();
    expect(yield* Effect.promise(() => startup)).toBeUndefined();
    expect(counts()).toEqual({ interruptions: 1, settlements: 0 });
    const listener = addEventListener.mock.calls[0]?.[1];
    expect(listener).toBeTypeOf("function");
    expect(removeEventListener).toHaveBeenCalledWith("abort", listener);
  }),
);

it.effect("shutdown interrupts a stalled startup once without activation or failure hooks", () =>
  Effect.gen(function* () {
    const { slot, started, counts } = yield* stalledSlot;
    const startup = slot.start(undefined);
    yield* Deferred.await(started);

    yield* Effect.promise(() => Promise.all([startup, slot.shutdown()]));
    expect(counts()).toEqual({ interruptions: 1, settlements: 0 });
    expect(slot.isActive()).toBe(false);
  }),
);

it.effect("contains slot hooks that return rejected thenables", () =>
  Effect.gen(function* () {
    let unhandled = 0;
    const record = () => void unhandled++;
    process.on("unhandledRejection", record);
    const rejected = () => Promise.reject(new Error("host hook rejected"));
    const slot = makePiSessionRuntimeSlot<void, never, never, never>({
      makeRuntime: () => hostRuntime(Layer.empty),
      startup: () => Effect.void,
      onActivated: rejected,
      onDeactivated: rejected,
    });
    yield* Effect.promise(() => slot.start(undefined));
    expect(slot.isActive()).toBe(true);
    yield* Effect.promise(() => slot.shutdown());
    yield* macrotask;
    process.off("unhandledRejection", record);
    expect(unhandled).toBe(0);
  }),
);

it.effect("waits for aborted runtime disposal before starting a replacement", () =>
  Effect.gen(function* () {
    const harness = yield* abortStalledStart();
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
    const harness = yield* abortStalledStart();
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
