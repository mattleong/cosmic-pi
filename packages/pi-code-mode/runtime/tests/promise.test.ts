import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CodeMode, Tool, toolError } from "../src/index.js";

// Wave 5 acceptance suite: first-class promise values. Un-awaited tool calls start eagerly on
// supervised fibers, `await` settles them, and Promise.all/allSettled/race/resolve/reject are
// ordinary functions over arbitrary arrays mixing promises and plain values.

type Trace = {
  starts: Array<number>;
  active: number;
  maxActive: number;
  completed: number;
  interrupted: number;
};

const makeTrace = (): Trace => ({
  starts: [],
  active: 0,
  maxActive: 0,
  completed: 0,
  interrupted: 0,
});

/** Echoes `id` after `ms` milliseconds, recording start order, live concurrency, and interruption. */
const sleepyTool = (trace: Trace) =>
  Tool.make({
    description: "Echo an id after a delay",
    input: Schema.Struct({ id: Schema.Number, ms: Schema.optionalKey(Schema.Number) }),
    output: Schema.Number,
    run: ({ id, ms }) =>
      Effect.gen(function* () {
        trace.starts.push(id);
        trace.active += 1;
        trace.maxActive = Math.max(trace.maxActive, trace.active);
        yield* Effect.sleep(ms ?? 20);
        trace.active -= 1;
        trace.completed += 1;
        return id;
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            trace.active -= 1;
            trace.interrupted += 1;
          }),
        ),
      ),
  });

const failingTool = Tool.make({
  description: "Always refuse",
  input: Schema.Struct({}),
  output: Schema.String,
  run: () => Effect.fail(toolError("Lookup refused")),
});

const run = (
  code: string,
  options: { trace?: Trace; limits?: CodeMode.ExecutionLimits } = {},
): Effect.Effect<CodeMode.Result> => {
  const trace = options.trace ?? makeTrace();
  return CodeMode.execute(
    options.limits
      ? {
          tools: { host: { sleepy: sleepyTool(trace), fail: failingTool } },
          code,
          limits: options.limits,
        }
      : { tools: { host: { sleepy: sleepyTool(trace), fail: failingTool } }, code },
  );
};

const value = (code: string, options: { trace?: Trace; limits?: CodeMode.ExecutionLimits } = {}) =>
  Effect.map(run(code, options), (result) => {
    if (!result.ok)
      throw new Error(`expected success, got ${result.error.kind}: ${result.error.message}`);
    return result.value;
  });

const error = (code: string, options: { trace?: Trace; limits?: CodeMode.ExecutionLimits } = {}) =>
  Effect.map(run(code, options), (result) => {
    if (result.ok) throw new Error(`expected failure, got value ${JSON.stringify(result.value)}`);
    return result.error;
  });

describe("first-class promise values", () => {
  it.live("an un-awaited tool call starts eagerly, in call order, before any await", () =>
    Effect.gen(function* () {
      const trace = makeTrace();
      const result = yield* value(
        `
        const a = tools.host.sleepy({ id: 1, ms: 40 })
        const b = tools.host.sleepy({ id: 2, ms: 40 })
        const rb = await b
        const ra = await a
        return [ra, rb]
      `,
        { trace },
      );
      expect(result).toEqual([1, 2]);
      expect(trace.starts).toEqual([1, 2]);
      // Both calls overlapped even though they were awaited sequentially.
      expect(trace.maxActive).toBeGreaterThan(1);
    }),
  );

  it.live("awaiting the same promise twice settles once and never re-runs the call", () =>
    Effect.gen(function* () {
      const result = yield* run(`
      const p = tools.host.sleepy({ id: 7 })
      const x = await p
      const y = await p
      return [x, y]
    `);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual([7, 7]);
      expect(result.toolCalls).toStrictEqual([{ name: "host.sleepy" }]);
    }),
  );

  it.live("await of a non-promise value is a passthrough no-op", () =>
    Effect.gen(function* () {
      expect(yield* value(`return await 42`)).toBe(42);
      expect(yield* value(`const x = await "s"; return x`)).toBe("s");
      expect(yield* value(`return await null`)).toBeNull();
      expect(yield* value(`return (await [1, 2]).length`)).toBe(2);
    }),
  );

  it.live("returning an un-awaited tool call resolves it (async-function return semantics)", () =>
    Effect.gen(function* () {
      expect(yield* value(`return tools.host.sleepy({ id: 9 })`)).toBe(9);
    }),
  );

  it.live("typeof a promise is 'object', and console.log renders it sensibly", () =>
    Effect.gen(function* () {
      const result = yield* run(`
      const p = Promise.resolve(1)
      console.log(p)
      return typeof p
    `);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe("object");
      expect(result.logs).toStrictEqual(["[Promise (await it to get its value)]"]);
    }),
  );

  it.live("an awaited failure is catchable exactly like a synchronous throw", () =>
    Effect.gen(function* () {
      expect(
        yield* value(`
      const p = tools.host.fail({})
      try {
        await p
        return "no"
      } catch (e) {
        return e.message
      }
    `),
      ).toBe("Lookup refused");
    }),
  );

  it.live("a fire-and-forget call completes before the execution ends", () =>
    Effect.gen(function* () {
      const trace = makeTrace();
      const result = yield* value(
        `
        tools.host.sleepy({ id: 1, ms: 30 })
        return "done"
      `,
        { trace },
      );
      expect(result).toBe("done");
      expect(trace.completed).toBe(1);
      expect(trace.interrupted).toBe(0);
    }),
  );

  it.live("a never-awaited failing call surfaces as an unhandled-rejection diagnostic", () =>
    Effect.gen(function* () {
      const diagnostic = yield* error(`
      tools.host.fail({})
      return "done"
    `);
      expect(diagnostic.kind).toBe("ToolFailure");
      expect(diagnostic.message).toContain("Unhandled rejection from an un-awaited tool call");
      expect(diagnostic.message).toContain("Lookup refused");
      expect(diagnostic.suggestions?.join(" ")).toContain("await tools.ns.tool(...)");
    }),
  );
});

describe("promises at data boundaries", () => {
  it.live("returning an un-awaited promise inside data is a clear await-hinting diagnostic", () =>
    Effect.gen(function* () {
      const diagnostic = yield* error(`return { result: tools.host.sleepy({ id: 1 }) }`);
      expect(diagnostic.kind).toBe("InvalidDataValue");
      expect(diagnostic.message).toContain("un-awaited Promise");
      expect(diagnostic.message).toContain("await tools.ns.tool(...)");
    }),
  );

  it.live("passing an un-awaited promise as a tool argument is a clear diagnostic", () =>
    Effect.gen(function* () {
      const diagnostic = yield* error(
        `return await tools.host.sleepy({ id: tools.host.sleepy({ id: 1 }) })`,
      );
      expect(diagnostic.kind).toBe("InvalidDataValue");
      expect(diagnostic.message).toContain("un-awaited Promise");
    }),
  );

  it.live("JSON.stringify of a promise is a diagnostic, not '{}'", () =>
    Effect.gen(function* () {
      const diagnostic = yield* error(`return JSON.stringify(Promise.resolve(1))`);
      expect(diagnostic.kind).toBe("InvalidDataValue");
      expect(diagnostic.message).toContain("un-awaited Promise");
    }),
  );

  it.live("operators reject promise operands", () =>
    Effect.gen(function* () {
      const diagnostic = yield* error(`return Promise.resolve(1) + 1`);
      expect(diagnostic.kind).toBe("InvalidDataValue");
    }),
  );
});

describe("Promise.all over arbitrary arrays", () => {
  it.live("mixes promises and plain values, preserving order", () =>
    Effect.gen(function* () {
      expect(
        yield* value(`
      return await Promise.all([tools.host.sleepy({ id: 1 }), "plain", tools.host.sleepy({ id: 2 }), 42])
    `),
      ).toEqual([1, "plain", 2, 42]);
    }),
  );

  it.live("accepts arrays built beforehand, passed as identifiers, and spread elements", () =>
    Effect.gen(function* () {
      expect(
        yield* value(`
      const calls = []
      calls.push(tools.host.sleepy({ id: 1 }))
      calls.push(7)
      const more = [tools.host.sleepy({ id: 2 })]
      const batch = [...calls, ...more, "x"]
      return await Promise.all(batch)
    `),
      ).toEqual([1, 7, 2, "x"]);
    }),
  );

  it.live("runs items.map tool calls in parallel", () =>
    Effect.gen(function* () {
      const trace = makeTrace();
      const result = yield* value(
        `
        const ids = [1, 2, 3, 4]
        return await Promise.all(ids.map((id) => tools.host.sleepy({ id, ms: 40 })))
      `,
        { trace },
      );
      expect(result).toEqual([1, 2, 3, 4]);
      // maxActive counts truly-overlapping live executions, so > 1 proves real
      // parallelism deterministically - no wall-clock assertion needed.
      expect(trace.maxActive).toBeGreaterThan(1);
    }),
  );

  it.live("caps live tool-call concurrency at the fixed internal constant (8)", () =>
    Effect.gen(function* () {
      const trace = makeTrace();
      const result = yield* value(
        `
        const ids = []
        for (let i = 0; i < 20; i += 1) ids.push(i)
        const results = await Promise.all(ids.map((id) => tools.host.sleepy({ id, ms: 10 })))
        return results.length
      `,
        { trace },
      );
      expect(result).toBe(20);
      expect(trace.maxActive).toBeGreaterThan(1);
      expect(trace.maxActive).toBeLessThanOrEqual(8);
    }),
  );

  it.live("resolves the empty array", () =>
    Effect.gen(function* () {
      expect(yield* value(`return await Promise.all([])`)).toEqual([]);
    }),
  );

  it.live("rejects with the first failure, catchable in-program", () =>
    Effect.gen(function* () {
      expect(
        yield* value(`
      try {
        await Promise.all([tools.host.sleepy({ id: 1 }), tools.host.fail({})])
        return "no"
      } catch (e) {
        return e.message
      }
    `),
      ).toBe("Lookup refused");
    }),
  );

  it.live("a non-collection argument is a clear error", () =>
    Effect.gen(function* () {
      const diagnostic = yield* error(`return await Promise.all(42)`);
      expect(diagnostic.message).toContain("Promise.all expects an array");
    }),
  );

  it.live("exceeding maxToolCalls inside Promise.all is a ToolCallLimitExceeded diagnostic", () =>
    Effect.gen(function* () {
      const diagnostic = yield* error(
        `return await Promise.all([tools.host.sleepy({ id: 1 }), tools.host.sleepy({ id: 2 }), tools.host.sleepy({ id: 3 })])`,
        { limits: { maxToolCalls: 2 } },
      );
      expect(diagnostic.kind).toBe("ToolCallLimitExceeded");
    }),
  );
});

describe("Promise.allSettled", () => {
  it.live("reports fulfilled and rejected outcomes with catch-normalized reasons", () =>
    Effect.gen(function* () {
      expect(
        yield* value(`
      return await Promise.allSettled([
        tools.host.sleepy({ id: 5 }),
        tools.host.fail({}),
        "plain",
        Promise.reject(new Error("boom")),
      ])
    `),
      ).toEqual([
        { status: "fulfilled", value: 5 },
        { status: "rejected", reason: { name: "Error", message: "Lookup refused" } },
        { status: "fulfilled", value: "plain" },
        { status: "rejected", reason: { name: "Error", message: "boom" } },
      ]);
    }),
  );

  it.live("never rejects for program-level failures", () =>
    Effect.gen(function* () {
      const result = yield* run(`
      const settled = await Promise.allSettled([tools.host.fail({}), tools.host.fail({})])
      return settled.filter((s) => s.status === "rejected").length
    `);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(2);
    }),
  );
});

describe("Promise.race", () => {
  it.live("lifecycle marks the losing call cancelled", () =>
    Effect.gen(function* () {
      const events: Array<CodeMode.ToolCallLifecycleEvent> = [];
      const trace = makeTrace();
      const result = yield* CodeMode.execute({
        tools: { host: { sleepy: sleepyTool(trace) } },
        code: `
          const fast = tools.host.sleepy({ id: 1, ms: 10 })
          const slow = tools.host.sleepy({ id: 2, ms: 5000 })
          return await Promise.race([fast, slow])
        `,
        onToolCallLifecycle: (event) => Effect.sync(() => events.push(event)),
      });
      expect(result.ok).toBe(true);
      expect(events.filter((event) => event.status === "succeeded")).toHaveLength(1);
      expect(events.filter((event) => event.status === "cancelled")).toHaveLength(1);
    }),
  );

  it.live("first settlement wins and losers are interrupted", () =>
    Effect.gen(function* () {
      const trace = makeTrace();
      const result = yield* value(
        `
        const fast = tools.host.sleepy({ id: 1, ms: 10 })
        const slow = tools.host.sleepy({ id: 2, ms: 5000 })
        return await Promise.race([fast, slow])
      `,
        { trace },
      );
      expect(result).toBe(1);
      expect(trace.interrupted).toBe(1);
      expect(trace.completed).toBe(1);
    }),
  );

  it.live("awaiting an interrupted loser afterwards is a catchable program failure", () =>
    Effect.gen(function* () {
      expect(
        yield* value(`
      const fast = tools.host.sleepy({ id: 1, ms: 10 })
      const slow = tools.host.sleepy({ id: 2, ms: 5000 })
      const winner = await Promise.race([fast, slow])
      try {
        await slow
        return "no"
      } catch (e) {
        return { winner, caught: e.message }
      }
    `),
      ).toEqual({
        winner: 1,
        caught:
          "This tool call was interrupted because another value settled a Promise.race first.",
      });
    }),
  );

  it.live("a rejection can win the race", () =>
    Effect.gen(function* () {
      expect(
        yield* value(`
      try {
        await Promise.race([tools.host.fail({}), tools.host.sleepy({ id: 1, ms: 5000 })])
        return "no"
      } catch (e) {
        return e.message
      }
    `),
      ).toBe("Lookup refused");
    }),
  );

  it.live("a plain value wins over pending promises", () =>
    Effect.gen(function* () {
      const trace = makeTrace();
      expect(
        yield* value(
          `return await Promise.race([tools.host.sleepy({ id: 1, ms: 5000 }), "immediate"])`,
          { trace },
        ),
      ).toBe("immediate");
      expect(trace.interrupted).toBe(1);
    }),
  );

  it.live("an empty race is a clear error instead of hanging", () =>
    Effect.gen(function* () {
      const diagnostic = yield* error(`return await Promise.race([])`);
      expect(diagnostic.message).toContain("never settle");
    }),
  );
});

describe("Promise.resolve / Promise.reject", () => {
  it.live("resolve wraps plain values and passes promises through", () =>
    Effect.gen(function* () {
      expect(yield* value(`return await Promise.resolve(42)`)).toBe(42);
      expect(yield* value(`return await Promise.resolve(Promise.resolve("nested"))`)).toBe(
        "nested",
      );
      expect(yield* value(`return await Promise.resolve(tools.host.sleepy({ id: 3 }))`)).toBe(3);
    }),
  );

  it.live("reject produces a promise whose await throws the reason", () =>
    Effect.gen(function* () {
      expect(
        yield* value(`
      try {
        await Promise.reject("nope")
        return "no"
      } catch (e) {
        return e
      }
    `),
      ).toBe("nope");
    }),
  );
});

describe("timeout interruption of forked calls", () => {
  it.live("lifecycle reports timeout interruption as cancelled", () =>
    Effect.gen(function* () {
      const events: Array<CodeMode.ToolCallLifecycleEvent> = [];
      const trace = makeTrace();
      const result = yield* CodeMode.execute({
        tools: { host: { sleepy: sleepyTool(trace) } },
        code: `return await tools.host.sleepy({ id: 1, ms: 60000 })`,
        limits: { timeoutMs: 50 },
        onToolCallLifecycle: (event) => Effect.sync(() => events.push(event)),
      });
      expect(result.ok).toBe(false);
      expect(events.at(-1)).toMatchObject({ status: "cancelled", started: true });
    }),
  );

  it.live("the execution timeout interrupts in-flight forked fibers", () =>
    Effect.gen(function* () {
      const trace = makeTrace();
      const result = yield* run(
        `
        const a = tools.host.sleepy({ id: 1, ms: 60000 })
        const b = tools.host.sleepy({ id: 2, ms: 60000 })
        return await a
      `,
        { trace, limits: { timeoutMs: 100 } },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("TimeoutExceeded");
      // Both calls started; neither escaped the timeout - the awaited one AND the abandoned one.
      expect(trace.starts).toEqual([1, 2]);
      expect(trace.interrupted).toBe(2);
      expect(trace.completed).toBe(0);
    }),
  );

  it.live("the timeout also interrupts calls inside Promise.all", () =>
    Effect.gen(function* () {
      const trace = makeTrace();
      const result = yield* run(
        `return await Promise.all([tools.host.sleepy({ id: 1, ms: 60000 }), tools.host.sleepy({ id: 2, ms: 60000 })])`,
        { trace, limits: { timeoutMs: 100 } },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("TimeoutExceeded");
      expect(trace.interrupted).toBe(2);
    }),
  );
});

describe("unsupported promise surface", () => {
  it.live(".then/.catch/.finally give a clear await-instead error", () =>
    Effect.gen(function* () {
      for (const method of ["then", "catch", "finally"]) {
        const diagnostic = yield* error(`return tools.host.sleepy({ id: 1 }).${method}((x) => x)`);
        expect(diagnostic.kind).toBe("UnsupportedSyntax");
        expect(diagnostic.message).toContain(`Promise.prototype.${method} is not supported`);
        expect(diagnostic.message).toContain("await");
      }
    }),
  );

  it.live("other property reads on a promise hint at the missing await", () =>
    Effect.gen(function* () {
      const diagnostic = yield* error(`return tools.host.sleepy({ id: 1 }).value`);
      expect(diagnostic.kind).toBe("InvalidDataValue");
      expect(diagnostic.message).toContain("un-awaited Promise");
      expect(diagnostic.message).toContain("await it first");
    }),
  );

  it.live("unknown Promise statics list what is available", () =>
    Effect.gen(function* () {
      const diagnostic = yield* error(`return await Promise.any([tools.host.sleepy({ id: 1 })])`);
      expect(diagnostic.message).toContain("Promise.any is not available");
      expect(diagnostic.message).toContain("Promise.allSettled");
    }),
  );

  it.live("new Promise(...) points at tool calls instead", () =>
    Effect.gen(function* () {
      const diagnostic = yield* error(`return new Promise((resolve) => resolve(1))`);
      expect(diagnostic.kind).toBe("UnsupportedSyntax");
      expect(diagnostic.message).toContain("new Promise(...) is not supported");
      expect(diagnostic.message).toContain("already return promises");
    }),
  );
});
