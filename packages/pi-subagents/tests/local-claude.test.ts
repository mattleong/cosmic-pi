import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { yieldUntil } from "pi-cosmic-core/testing";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { makeLocalClaudeInputDelivery } from "../src/backend/local-claude-input-delivery.ts";

/** Input delivery whose preparation pauses until the test releases it. */
const gatedInputs = (scope: Scope.Scope) => {
  const preparing = Deferred.makeUnsafe<void>();
  const release = Deferred.makeUnsafe<void>();
  let sends = 0;
  const inputs = makeLocalClaudeInputDelivery(
    {
      send: () =>
        Effect.sync(() => {
          sends++;
        }),
      terminate: () => Effect.void,
    },
    scope,
    () => Deferred.succeed(preparing, undefined).pipe(Effect.andThen(Deferred.await(release))),
  );
  return { inputs, preparing, release, sends: () => sends };
};

describe("Claude input delivery ownership", () => {
  it.effect("closed scope rejects new input and releases admission racing preparation", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const { inputs, preparing, release, sends } = gatedInputs(scope);
      const caller = yield* Effect.forkChild(inputs.send("Guidance", 1, "steer"));
      yield* Deferred.await(preparing);
      yield* Scope.close(scope, Exit.void);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.await(caller);
      expect(inputs.pending).toBeUndefined();
      expect(Exit.isFailure(yield* Effect.exit(inputs.send("Later guidance", 1, "steer")))).toBe(
        true,
      );
      expect(inputs.pending).toBeUndefined();
      expect(sends()).toBe(0);
    }),
  );
  it.effect("cancellation before native send releases admission without sending later", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { inputs, preparing, release, sends } = gatedInputs(yield* Scope.Scope);
        const caller = yield* Effect.forkChild(inputs.send("Guidance", 1, "steer"));
        yield* Deferred.await(preparing);
        yield* Fiber.interrupt(caller);
        yield* Deferred.succeed(release, undefined);
        yield* Effect.yieldNow;
        expect(sends()).toBe(0);
        expect(inputs.pending).toBeUndefined();
      }),
    ),
  );

  it.effect("cancellation after native send retains the UUID until exact acknowledgement", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Scope.Scope;
        const sent = Deferred.makeUnsafe<void>();
        const inputs = makeLocalClaudeInputDelivery(
          {
            send: () => Deferred.succeed(sent, undefined).pipe(Effect.asVoid),
            terminate: () => Effect.void,
          },
          scope,
          () => Effect.void,
        );
        const caller = yield* Effect.forkChild(inputs.send("Guidance", 1, "steer"));
        yield* Deferred.await(sent);
        const pending = inputs.pending;
        expect(pending).toBeDefined();
        yield* Fiber.interrupt(caller);
        expect(inputs.pending).toBe(pending);
        if (!pending) return yield* Effect.die("Missing sent input");
        yield* Deferred.succeed(pending.acknowledgement, undefined);
        yield* yieldUntil(() => inputs.pending === undefined);
      }),
    ),
  );
});
