// Local execution-state regressions; see PROVENANCE.md.
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CodeMode, Tool } from "../src/index.js";
import { setDeadlineClockForTesting } from "../src/interpreter/deadline.js";

describe("reusable execution Effects", () => {
  for (const concurrent of [false, true]) {
    it.effect(
      `isolates tool budgets and logs on ${concurrent ? "concurrent" : "sequential"} reuse`,
      () =>
        Effect.gen(function* () {
          const bothStarted = yield* Deferred.make<void>();
          let calls = 0;
          const execution = CodeMode.execute({
            code: `const id = await tools.next({}); console.log(id); return id;`,
            limits: { maxToolCalls: 1 },
            tools: {
              next: Tool.make({
                description: "Return an invocation number",
                input: Schema.Struct({}),
                output: Schema.Finite,
                run: () =>
                  Effect.gen(function* () {
                    const id = ++calls;
                    if (concurrent) {
                      if (calls === 2) yield* Deferred.succeed(bothStarted, undefined);
                      yield* Deferred.await(bothStarted);
                    }
                    return id;
                  }),
              }),
            },
          });
          const results = concurrent
            ? yield* Effect.all([execution, execution], { concurrency: "unbounded" })
            : [yield* execution, yield* execution];
          expect(results).toEqual([
            { ok: true, value: 1, logs: ["1"], toolCalls: [{ name: "next" }] },
            { ok: true, value: 2, logs: ["2"], toolCalls: [{ name: "next" }] },
          ]);
          expect(calls).toBe(2);
        }),
    );
  }

  it.effect("starts a fresh deadline when the Effect runs, not when it is constructed", () =>
    Effect.gen(function* () {
      let now = 0;
      setDeadlineClockForTesting(() => now);
      try {
        const execution = CodeMode.execute({ code: "return 1;", limits: { timeoutMs: 100 } });
        now = 1_000;
        expect(yield* execution).toMatchObject({ ok: true, value: 1 });
        now = 2_000;
        expect(yield* execution).toMatchObject({ ok: true, value: 1 });
      } finally {
        setDeadlineClockForTesting(undefined);
      }
    }),
  );
});
