import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import { yieldUntil } from "pi-cosmic-core/testing";
import { makeLocalPiBackendDriver } from "../src/backend/local-pi.ts";
import type { ChildWireEvent } from "../src/boundary/child-process.ts";
import type { SubagentError } from "../src/run/errors.ts";
import { backendLaunch } from "./fixtures/backend-supervisor.ts";

describe("local Pi startup transport closure", () => {
  for (const ending of ["exit", "shutdown"] as const) {
    it.effect(`keeps diagnostic receipt waiting interruptible on ${ending}`, () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const events = yield* Queue.unbounded<ChildWireEvent, Cause.Done>();
        const receipt = yield* Deferred.make<Extract<ChildWireEvent, { type: "exit" }>>();
        let requested = false;
        let readingExit = false;
        let failure: SubagentError | undefined;
        const driver = makeLocalPiBackendDriver({
          reclaimRunState: () => Effect.void,
          spawn: () =>
            Effect.succeed({
              pid: 4242,
              events,
              awaitExit: Effect.sync(() => {
                readingExit = true;
              }).pipe(Effect.andThen(Deferred.await(receipt))),
              send: () =>
                Effect.sync(() => {
                  requested = true;
                }),
              sendContactControl: () => Effect.void,
              terminate: () => Effect.void,
            }),
        });
        const backend = yield* driver
          .spawn(backendLaunch())
          .pipe(Effect.provideService(Scope.Scope, scope));
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
        yield* yieldUntil(() => requested);
        // Force queue completion ahead of the receipt. The old generic finalizer rejected
        // startup here, permanently losing stderr that arrived through awaitExit afterward.
        Queue.endUnsafe(events);
        yield* yieldUntil(() => readingExit || failure !== undefined);
        expect(failure).toBeUndefined();
        if (ending === "exit") {
          yield* Deferred.succeed(receipt, {
            type: "exit",
            exitCode: 1,
            stderr: "Failed to load extension: missing entrypoint",
          });
          const error = yield* Fiber.join(initializing);
          expect(error.message).toContain("missing entrypoint");
          expect(error.message).toContain("code 1");
        } else {
          // Teardown must not wait for a never-arriving process receipt.
          yield* Scope.close(scope, Exit.void);
          expect((yield* Fiber.join(initializing))._tag).toBe("SubagentProcessError");
        }
      }),
    );
  }

  it.effect("keeps the fatal end of stderr that overflows the diagnostic budget", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<ChildWireEvent, Cause.Done>();
      const receipt = yield* Deferred.make<Extract<ChildWireEvent, { type: "exit" }>>();
      let requested = false;
      const driver = makeLocalPiBackendDriver({
        reclaimRunState: () => Effect.void,
        spawn: () =>
          Effect.succeed({
            pid: 4242,
            events,
            awaitExit: Deferred.await(receipt),
            send: () =>
              Effect.sync(() => {
                requested = true;
              }),
            sendContactControl: () => Effect.void,
            terminate: () => Effect.void,
          }),
      });
      const backend = yield* driver.spawn(backendLaunch());
      const initializing = yield* backend.controls.initialize.pipe(Effect.flip, Effect.forkScoped);
      yield* yieldUntil(() => requested);
      yield* Deferred.succeed(receipt, {
        type: "exit",
        exitCode: 1,
        stderr: `${"Warning: deprecated extension option\n".repeat(400)}Fatal: missing entrypoint`,
      });
      Queue.endUnsafe(events);
      const error = yield* Fiber.join(initializing);
      expect(error.message).toContain("code 1");
      expect(error.message).toContain("Fatal: missing entrypoint");
    }),
  );
});
