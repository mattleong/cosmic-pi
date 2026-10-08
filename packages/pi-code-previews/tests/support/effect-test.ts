// Shared Effect-generator test registration for promise-shaped test boundaries.
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export { eventLoopTurn, settle, step } from "pi-cosmic-core/testing";

/** Registers one @effect/vitest test whose body is a single scoped Effect generator. */
export const effectTest = (
  name: string,
  body: () => Generator<Effect.Effect<any, never, Scope.Scope>, void, never>,
): void => it.effect(name, () => Effect.gen(body));
