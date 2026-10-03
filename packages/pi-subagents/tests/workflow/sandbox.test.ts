import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import { describe, expect, it } from "vitest";
import {
  runWorkflowSandbox,
  type WorkflowSandboxHost,
} from "../../src/boundary/codemode-sandbox.ts";

const host = (overrides: Partial<WorkflowSandboxHost<never>> = {}): WorkflowSandboxHost<never> => ({
  agent: () => Effect.succeed({ result: "done", outputTokens: 1 }),
  event: () => Effect.void,
  load: () => Effect.fail({ message: "no saved workflows" }),
  ...overrides,
});

describe("workflow sandbox boundary", () => {
  it("returns the script value and its text output", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const outcome = yield* Effect.scoped(
          runWorkflowSandbox(
            "console.log('hi'); return { got: await agent('x'), args };",
            { n: 1 },
            host(),
          ),
        );
        expect(outcome).toEqual({
          _tag: "Completed",
          value: { got: "done", args: { n: 1 } },
          output: ["hi"],
        });
      }),
    ));

  it("reports script failures with their message", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const outcome = yield* Effect.scoped(
          runWorkflowSandbox("await workflow('x');", null, host()),
        );
        expect(outcome).toMatchObject({
          _tag: "Failed",
          kind: "script",
          failure: { message: "no saved workflows" },
        });
      }),
    ));

  it("interrupts and joins running host calls when the run is interrupted", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const finalized = yield* Ref.make(false);
        const fiber = yield* Effect.forkChild(
          Effect.scoped(
            runWorkflowSandbox(
              "return await agent('long');",
              null,
              host({
                agent: () =>
                  Deferred.succeed(started, undefined).pipe(
                    Effect.andThen(Effect.never),
                    Effect.ensuring(
                      Effect.sleep("20 millis").pipe(Effect.andThen(Ref.set(finalized, true))),
                    ),
                  ),
              }),
            ),
          ),
        );
        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
        expect(yield* Ref.get(finalized)).toBe(true);
      }),
    ));

  it("aborts the script on request and keeps the output it produced", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const stop = yield* Deferred.make<void>();
        const fiber = yield* Effect.forkChild(
          Effect.scoped(
            runWorkflowSandbox(
              "console.log('before the agent'); return await agent('long');",
              null,
              host({
                agent: () =>
                  Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
              }),
              Deferred.await(stop),
            ),
          ),
        );
        yield* Deferred.await(started);
        yield* Deferred.succeed(stop, undefined);
        expect(yield* Fiber.join(fiber)).toMatchObject({
          _tag: "Failed",
          kind: "aborted",
          output: ["before the agent"],
        });
      }),
    ));

  it("interrupts host calls the script left running when it returns", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const interrupted = yield* Deferred.make<void>();
        const outcome = yield* Effect.scoped(
          runWorkflowSandbox(
            "agent('forgotten'); return 'early';",
            null,
            host({
              agent: () =>
                Effect.never.pipe(
                  Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
                ),
            }),
          ),
        );
        expect(outcome).toMatchObject({ _tag: "Completed", value: "early" });
        yield* Deferred.await(interrupted).pipe(Effect.timeout("2 seconds"));
      }),
    ));
});
