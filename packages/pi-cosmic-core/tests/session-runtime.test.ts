// Pi lifecycle characterization intentionally exercises AbortController.
// @effect-diagnostics effect/abortController:off
// @effect-diagnostics effect/newPromise:off
// Test-only runtime driver captures the host-boundary startup span.
// @effect-diagnostics effect/runEffectInsideEffect:off
// @effect-diagnostics effect/anyUnknownInErrorContext:off
// @effect-diagnostics effect/unsafeEffectTypeAssertion:off
// @effect-diagnostics effect/strictEffectProvide:off
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
} from "../index.ts";
import { makeCapturedTracer } from "../testing.ts";

it.effect("replaces a stalled runtime and releases every acquired layer exactly once", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const firstStarted = yield* Deferred.make<void>();
    const pi = {} as ExtensionAPI;
    const slot = makePiSessionRuntimeSlot<number, never, never>({
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
    });

    const first = slot.start(1);
    yield* Deferred.await(firstStarted);
    const second = slot.start(2);
    const tokens = yield* Effect.promise(() => Promise.all([first, second]));
    expect(tokens[0]).toBeUndefined();
    expect(tokens[1]).toBe(2);
    expect(events).toEqual(["acquire:1", "release:1", "acquire:2"]);

    yield* Effect.promise(() => slot.shutdown());
    yield* Effect.promise(() => slot.shutdown());
    expect(events).toEqual(["acquire:1", "release:1", "acquire:2", "release:2"]);
  }),
);

it.effect("captures a stable runtime startup span without session input", () =>
  Effect.gen(function* () {
    const captured = makeCapturedTracer();
    const runtime: PiManagedRuntime<never> = {
      run: (effect) =>
        Effect.runPromise(
          (effect as Effect.Effect<unknown, unknown>).pipe(Effect.provide(captured.layer)),
        ) as Promise<never>,
      fork: (effect) => Effect.runFork(effect as Effect.Effect<never>),
      runSync: (effect) => Effect.runSync(effect as Effect.Effect<never>),
      dispose: () => Promise.resolve(),
    };
    const slot = makePiSessionRuntimeSlot<string, never>({
      makeRuntime: () => runtime,
      startup: () => Effect.void,
    });
    expect(yield* Effect.promise(() => slot.start("secret-session-input"))).toBe(1);
    expect(captured.spans.map((span) => span.name)).toContain("pi-cosmic-core.runtime.startup");
    expect(captured.spans.map((span) => span.name).join(" ")).not.toContain("secret-session-input");
    yield* Effect.promise(() => slot.shutdown());
  }),
);

it.effect("releases acquired resources after startup failure", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const failures: number[] = [];
    const slot = makePiSessionRuntimeSlot<void, never, "startup">({
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

it.effect("disposes an already-aborted start and leaves the slot unavailable", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const controller = new AbortController();
    controller.abort();
    const slot = makePiSessionRuntimeSlot<void, never>({
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
