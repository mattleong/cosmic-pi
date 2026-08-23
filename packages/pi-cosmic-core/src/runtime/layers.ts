import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * Builds a Layer inside an effect-owned Scope and provides the built services
 * to one effect.
 *
 * This is the entry-point form of Layer provision for host boundaries and
 * tests: the wrapped effect owns the build lifetime explicitly, so scoped
 * layer resources are released when that effect settles instead of leaking
 * past it, and the effect's own Scope requirement (if any) stays with its
 * caller.
 */
export const provideBuiltLayer =
  <ROut, E2, RIn>(layer: Layer.Layer<ROut, E2, RIn>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | E2, RIn | Exclude<R, ROut>> =>
    Effect.scopedWith((scope) =>
      Layer.buildWithScope(layer, scope).pipe(
        Effect.flatMap((services) => Effect.provide(effect, services)),
      ),
    );
