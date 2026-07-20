// @effect-diagnostics effect/strictEffectProvide:off
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AgentDirectory } from "../index.ts";

it.effect("provides an explicit agent directory", () =>
  Effect.gen(function* () {
    expect(yield* AgentDirectory).toBe("/agent");
  }).pipe(Effect.provide(AgentDirectory.layer("/agent"))),
);

it.effect("translates host lookup failure into a tagged error", () =>
  Effect.gen(function* () {
    const layer = AgentDirectory.layerFromHost(() => {
      throw new Error("secret host failure");
    });
    const result = yield* Effect.result(Layer.build(layer));
    expect(result._tag).toBe("Failure");
  }).pipe(Effect.scoped),
);
