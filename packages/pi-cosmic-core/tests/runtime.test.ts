import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PiApi } from "../src/pi-api.ts";
import { makePiManagedRuntime, makePiRuntime } from "../src/runtime.ts";
import { makeLifecycleProbe } from "../testing.ts";

const makeHostileSignal = (operation: "aborted" | "addEventListener") => {
  const controller = new AbortController();
  let removals = 0;
  const signal = new Proxy(controller.signal, {
    get(target, property) {
      if (property === "aborted" && operation === "aborted")
        throw new Error("hostile aborted getter");
      if (property === "addEventListener" && operation === "addEventListener")
        return (...args: Parameters<AbortSignal["addEventListener"]>) => {
          target.addEventListener(...args);
          throw new Error("hostile addEventListener");
        };
      if (property === "removeEventListener")
        return (...args: Parameters<AbortSignal["removeEventListener"]>) => {
          removals++;
          return target.removeEventListener(...args);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { signal, removals: () => removals };
};

it.effect("provides the pi host API through one managed runtime", () =>
  Effect.gen(function* () {
    const pi = { marker: "pi-api" } as unknown as ExtensionAPI;
    const marker = yield* Effect.acquireUseRelease(
      Effect.sync(() => makePiRuntime(pi)),
      (runtime) =>
        Effect.promise(() =>
          runtime.runPromise(
            PiApi.use((api) => Effect.succeed((api as unknown as { marker: string }).marker)),
          ),
        ),
      (runtime) => runtime.disposeEffect,
    );

    expect(marker).toBe("pi-api");
  }),
);

it.effect("releases layer resources when the managed runtime is disposed", () =>
  Effect.gen(function* () {
    const probe = makeLifecycleProbe();

    yield* Effect.acquireUseRelease(
      Effect.sync(() => ManagedRuntime.make(probe.layer)),
      (runtime) => Effect.promise(() => runtime.runPromise(Effect.void)),
      (runtime) => runtime.disposeEffect,
    );

    expect(probe.events).toEqual(["acquired", "released"]);
    expect(probe.acquired()).toBe(1);
    expect(probe.released()).toBe(1);
  }),
);

for (const operation of ["aborted", "addEventListener"] as const) {
  it.effect(`normalizes a hostile ${operation} signal before running a fiber`, () =>
    Effect.gen(function* () {
      const host = makeHostileSignal(operation);
      const runtime = makePiManagedRuntime({} as ExtensionAPI, Layer.empty);
      yield* Effect.promise(() => runtime.run(Effect.void));
      let started = false;
      let finalized = false;
      const running = runtime.run(
        Effect.sync(() => void (started = true)).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Effect.sync(() => void (finalized = true))),
        ),
        host.signal,
      );

      expect(running).toBeInstanceOf(Promise);
      yield* Effect.promise(() => running.catch(() => undefined));
      expect({ finalized, removals: host.removals(), started }).toEqual({
        finalized: true,
        removals: 1,
        started: true,
      });
      yield* Effect.promise(() => runtime.dispose());
    }),
  );
}

it.effect("releases an adapted host signal when a forked fiber terminates", () =>
  Effect.gen(function* () {
    const host = makeHostileSignal("addEventListener");
    const runtime = makePiManagedRuntime({} as ExtensionAPI, Layer.empty);
    yield* Effect.promise(() => runtime.run(Effect.void));
    let finalized = false;
    const fiber = runtime.fork(
      Effect.never.pipe(Effect.ensuring(Effect.sync(() => void (finalized = true)))),
      host.signal,
    );

    yield* Fiber.await(fiber);
    expect(finalized).toBe(true);
    expect(host.removals()).toBe(1);
    yield* Effect.promise(() => runtime.dispose());
  }),
);
