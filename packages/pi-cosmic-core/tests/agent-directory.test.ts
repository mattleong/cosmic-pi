import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AgentDirectory } from "../index.ts";

it.effect("translates host lookup failure into a tagged error", () =>
  Effect.gen(function* () {
    const layer = AgentDirectory.layerFromHost(() => {
      throw new Error("secret host failure");
    });
    const result = yield* Effect.result(Layer.build(layer));
    expect(result._tag).toBe("Failure");
  }).pipe(Effect.scoped),
);
