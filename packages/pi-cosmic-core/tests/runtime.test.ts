import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { PiApi } from "../src/runtime/pi-api.ts";
import { makePiManagedRuntime, makePiRuntime, piHostLoggerLayer } from "../src/runtime/runtime.ts";
import { extensionApiFixture } from "../testing.ts";
import { silencedConsole } from "./support/spies.ts";

const makeHostileSignal = (operation: "aborted" | "addEventListener") => {
  const { signal } = new AbortController();
  const addEventListener = signal.addEventListener.bind(signal);
  const removeEventListener = signal.removeEventListener.bind(signal);
  let removals = 0;
  if (operation === "aborted")
    Object.defineProperty(signal, "aborted", {
      get() {
        throw new Error("hostile aborted getter");
      },
    });
  else
    Object.defineProperty(signal, "addEventListener", {
      value: (...args: Parameters<AbortSignal["addEventListener"]>) => {
        addEventListener(...args);
        throw new Error("hostile addEventListener");
      },
    });
  Object.defineProperty(signal, "removeEventListener", {
    value: (...args: Parameters<AbortSignal["removeEventListener"]>) => {
      removals++;
      return removeEventListener(...args);
    },
  });
  return { signal, removals: () => removals };
};

it.effect("provides the pi host API through one managed runtime", () =>
  Effect.gen(function* () {
    const pi = extensionApiFixture();
    const marker = yield* Effect.acquireUseRelease(
      Effect.sync(() => makePiRuntime(pi, Layer.empty)),
      (runtime) =>
        Effect.promise(() =>
          runtime.runPromise(
            PiApi.use((api) => Effect.succeed(api === pi ? "pi-api" : "wrong-api")),
          ),
        ),
      (runtime) => runtime.disposeEffect,
    );

    expect(marker).toBe("pi-api");
  }),
);

it.effect("keeps Effect log output off the TTY console", () =>
  Effect.gen(function* () {
    const consoleCalls = yield* silencedConsole;
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() => makePiManagedRuntime(extensionApiFixture({}), Layer.empty)),
      (runtime) => Effect.promise(() => runtime.dispose()),
    );
    yield* Effect.promise(() =>
      runtime.run(Effect.logWarning("Subscription usage recovery: refresh_failed.")),
    );
    yield* Effect.logWarning("standalone host logger must stay off the TTY").pipe(
      Effect.provide(piHostLoggerLayer),
    );
    expect(consoleCalls()).toBe(0);
  }),
);

for (const operation of ["aborted", "addEventListener"] as const) {
  it.effect(`normalizes a hostile ${operation} signal before running a fiber`, () =>
    Effect.gen(function* () {
      const host = makeHostileSignal(operation);
      const runtime = makePiManagedRuntime(extensionApiFixture({}), Layer.empty);
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
    const runtime = makePiManagedRuntime(extensionApiFixture({}), Layer.empty);
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
