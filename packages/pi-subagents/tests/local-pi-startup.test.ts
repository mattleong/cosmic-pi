import { describe, expect, it } from "@effect/vitest";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import { yieldUntil } from "pi-cosmic-core/testing";
import type { ChildWireEvent } from "../src/boundary/child-process.ts";
import type { ProcessExit } from "../src/boundary/process-transport.ts";
import { SubagentProcessError, type SubagentError } from "../src/run/errors.ts";
import { piChild, spawnPi } from "./fixtures/backend-launch.ts";

const fakePiChild = Effect.gen(function* () {
  const events = yield* Queue.unbounded<ChildWireEvent, Cause.Done>();
  const receipt = yield* Deferred.make<ProcessExit>();
  const state = { requested: false, readingExit: false };
  const spawn = spawnPi(
    Effect.succeed(
      piChild(events, {
        awaitExit: Effect.sync(() => {
          state.readingExit = true;
        }).pipe(Effect.andThen(Deferred.await(receipt))),
        send: () =>
          Effect.sync(() => {
            state.requested = true;
          }),
      }),
    ),
  );
  return { events, receipt, state, spawn };
});

describe("local Pi startup transport closure", () => {
  for (const ending of ["exit", "shutdown"] as const) {
    it.effect(`keeps diagnostic receipt waiting interruptible on ${ending}`, () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const { events, receipt, state, spawn } = yield* fakePiChild;
        let failure: SubagentError | undefined;
        const backend = yield* spawn.pipe(Effect.provideService(Scope.Scope, scope));
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const initializing = yield* backend.controls.initialize.pipe(
          Effect.flip,
          Effect.tap((error) =>
            Effect.sync(() => {
              failure = error;
            }),
          ),
          Effect.forkScoped,
        );
        yield* yieldUntil(() => state.requested);
        Queue.endUnsafe(events);
        yield* yieldUntil(() => state.readingExit || failure !== undefined);
        expect(failure).toBeUndefined();
        if (ending === "exit") {
          yield* Deferred.succeed(receipt, {
            exitCode: 1,
            stderr: "Failed to load extension: missing entrypoint",
          });
          const error = yield* Fiber.join(initializing);
          expect(error.message).toContain("missing entrypoint");
          expect(error.message).toContain("code 1");
        } else {
          yield* Scope.close(scope, Exit.void);
          expect(yield* Fiber.join(initializing)).toBeInstanceOf(SubagentProcessError);
        }
      }),
    );
  }
});
