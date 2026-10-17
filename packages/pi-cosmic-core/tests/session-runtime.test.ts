import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vitest";
import {
  makePiManagedRuntime,
  makePiSessionRuntimeSlot,
  PiApi,
  type PiManagedRuntime,
} from "../index.ts";
import { extensionApiFixture, makeLifecycleProbe } from "../testing.ts";

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
  makePiManagedRuntime(extensionApiFixture(), layer);

const runStartup: PiManagedRuntime<never, never>["run"] = (effect) =>
  Effect.runPromise(Effect.provideService(effect, PiApi, extensionApiFixture()));

function abortStalledStart() {
  const events: string[] = [];
  const startedGate = Deferred.makeUnsafe<void>();
  const disposalGate = Deferred.makeUnsafe<void>();
  const started = Effect.runPromise(Deferred.await(startedGate));
  const disposal = Effect.runPromise(Deferred.await(disposalGate));
  const slot = makePiSessionRuntimeSlot<number, never, never, never>({
    makeRuntime: (input) =>
      fakeRuntime(
        (effect, signal) => {
          events.push(`run:${input}`);
          if (input !== 1) {
            return runStartup(effect);
          }
          Deferred.doneUnsafe(startedGate, Effect.void);
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

it.effect("ends captured command authority at the next lifecycle change, never restoring it", () =>
  Effect.gen(function* () {
    const startupEntered = yield* Deferred.make<void>();
    const releaseStartup = yield* Deferred.make<void>();
    const slot = makePiSessionRuntimeSlot<"ready" | "fail", never, "startup", never>({
      makeRuntime: () => hostRuntime(Layer.empty),
      startup: (input) =>
        input === "fail"
          ? Effect.fail("startup" as const)
          : Deferred.succeed(startupEntered, undefined).pipe(
              Effect.andThen(Deferred.await(releaseStartup)),
            ),
    });

    const beforeStart = slot.captureAuthority();
    expect(beforeStart()).toBe(true);
    const starting = slot.start("ready");
    expect(beforeStart()).toBe(false);

    yield* Deferred.await(startupEntered);
    const duringStartup = slot.captureAuthority();
    yield* Deferred.succeed(releaseStartup, undefined);
    expect(yield* Effect.promise(() => starting)).toBe(1);
    expect(duringStartup()).toBe(true);

    const active = slot.captureAuthority();
    expect(yield* Effect.promise(() => slot.start("fail"))).toBeUndefined();
    expect(active()).toBe(false);
    const afterFailure = slot.captureAuthority();
    expect(afterFailure()).toBe(true);
    yield* Effect.promise(() => slot.shutdown());
    expect(afterFailure()).toBe(false);
    expect([beforeStart, duringStartup, active].some((current) => current())).toBe(false);
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
    expect(removeEventListener).toHaveBeenCalledWith("abort", listener);
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
