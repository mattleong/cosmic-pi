import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PiApi } from "../src/pi-api.ts";
import { makePiRuntime } from "../src/runtime.ts";

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
    const events: string[] = [];
    const resourceLayer = Layer.effectDiscard(
      Effect.acquireRelease(
        Effect.sync(() => events.push("acquired")),
        () => Effect.sync(() => events.push("released")),
      ),
    );

    yield* Effect.acquireUseRelease(
      Effect.sync(() => ManagedRuntime.make(resourceLayer)),
      (runtime) => Effect.promise(() => runtime.runPromise(Effect.void)),
      (runtime) => runtime.disposeEffect,
    );

    expect(events).toEqual(["acquired", "released"]);
  }),
);
