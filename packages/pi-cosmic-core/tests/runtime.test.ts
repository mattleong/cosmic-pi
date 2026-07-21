import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PiApi } from "../src/pi-api.ts";
import { makePiRuntime } from "../src/runtime.ts";
import { makeLifecycleProbe } from "../testing.ts";

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
