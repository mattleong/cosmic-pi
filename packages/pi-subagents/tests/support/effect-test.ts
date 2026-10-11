import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export { eventLoopTurn, maybe, settle, step } from "pi-cosmic-core/testing";

export const effectTest = (
  name: string,
  body: () => Generator<Effect.Effect<unknown, never, Scope.Scope>, void, never>,
): void => it.effect(name, () => Effect.gen(body));
