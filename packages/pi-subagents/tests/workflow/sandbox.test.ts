import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";
import {
  runWorkflowSandbox,
  type WorkflowSandboxHost,
} from "../../src/boundary/codemode-sandbox.ts";
import { WORKFLOW_PRELUDE, workflowScriptStack } from "../../src/workflow/prelude.ts";
import { WorkflowSourceError } from "../../src/workflow/store.ts";

const host = (overrides: Partial<WorkflowSandboxHost<never>> = {}): WorkflowSandboxHost<never> => ({
  agent: () => Effect.succeed({ result: "done", outputTokens: 1 }),
  event: () => Effect.void,
  load: () =>
    Effect.fail(
      new WorkflowSourceError({
        message: "no saved workflows",
        problem: "not-found",
        subject: "x",
      }),
    ),
  ...overrides,
});

/** Runs a script in a scope of its own, against {@link host} with `overrides`. */
const execute = (
  body: string,
  overrides: Partial<WorkflowSandboxHost<never>> = {},
  { args = null, abort = Effect.never }: { args?: Schema.Json; abort?: Effect.Effect<void> } = {},
) => Effect.scoped(runWorkflowSandbox(body, args, host(overrides), abort, undefined));

describe("workflow sandbox boundary", () => {
  it.live("returns the script value and its text output", () =>
    Effect.gen(function* () {
      const outcome = yield* execute(
        "console.log('hi'); return { got: await agent('x'), args };",
        {},
        { args: { n: 1 } },
      );
      expect(outcome).toEqual({
        _tag: "Completed",
        value: { got: "done", args: { n: 1 } },
        output: ["hi"],
      });
    }),
  );

  it.live("reports script failures with their message", () =>
    Effect.gen(function* () {
      const outcome = yield* execute("await workflow('x');");
      expect(outcome).toMatchObject({
        _tag: "Failed",
        kind: "script",
        failure: { message: "no saved workflows" },
      });
    }),
  );

  it.live("reports a failure's stack in script lines, without the prelude's frames", () =>
    Effect.gen(function* () {
      const outcome = yield* execute(
        "const a = 1;\nconst read = (value) => value.missing.deeper;\nread(null);",
      );
      expect(outcome._tag).toBe("Failed");
      const stack = outcome._tag === "Failed" ? (outcome.failure.stack ?? "") : "";
      expect(stack).toMatch(/line 2:\d+/u);
      expect(stack).not.toContain("codemode.js");
      expect(stack).not.toContain(outcome._tag === "Failed" ? outcome.failure.message : "");
    }),
  );

  it("maps sandbox positions on the prelude's line to the script's first line", () => {
    const scriptStart = "(async (tools, console) => {".length + WORKFLOW_PRELUDE.length;
    const stack = [
      "Error: boom",
      `    at agent (codemode.js:1:${scriptStart - 10})`,
      `    at <anonymous> (codemode.js:1:${scriptStart + 7})`,
      "    at map (native)",
      "    at <anonymous> (codemode.js:4:2)",
    ].join("\n");
    expect(workflowScriptStack(stack)).toBe("at <anonymous> (line 1:7)\nat <anonymous> (line 4:2)");
    expect(workflowScriptStack("Error: boom\n    at agent (codemode.js:1:5)")).toBeUndefined();
  });

  it.live("interrupts and joins running host calls when the run is interrupted", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const finalized = yield* Ref.make(false);
      const fiber = yield* Effect.forkChild(
        execute("return await agent('long');", {
          agent: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.sleep("20 millis").pipe(Effect.andThen(Ref.set(finalized, true))),
              ),
            ),
        }),
      );
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      expect(yield* Ref.get(finalized)).toBe(true);
    }),
  );

  it.live("aborts the script on request and keeps the output it produced", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const stop = yield* Deferred.make<void>();
      const fiber = yield* Effect.forkChild(
        execute(
          "console.log('before the agent'); return await agent('long');",
          { agent: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)) },
          { abort: Deferred.await(stop) },
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
  );

  it.live("interrupts host calls the script left running when it returns", () =>
    Effect.gen(function* () {
      const interrupted = yield* Deferred.make<void>();
      const outcome = yield* execute("agent('forgotten'); return 'early';", {
        agent: () =>
          Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))),
      });
      expect(outcome).toMatchObject({ _tag: "Completed", value: "early" });
      yield* Deferred.await(interrupted).pipe(Effect.timeout("2 seconds"));
    }),
  );
});
