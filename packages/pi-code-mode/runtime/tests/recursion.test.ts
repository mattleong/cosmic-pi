import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { CodeMode, Tool } from "../src/index.js";
import { parseProgram } from "../src/interpreter/diagnostics.js";
import { RecursionBudget } from "../src/interpreter/recursion.js";
import { runProgram } from "../src/interpreter/execution.js";

// A smaller internal budget exercises the same entry/continuation paths without
// retaining ten thousand async activations and their descendant ownership sets.
const run = (code: string) =>
  Effect.suspend(() => {
    return runProgram<never>(parseProgram(code), {
      admitTool: () => Effect.die("No tools in this fixture"),
      toolKeys: () => [],
      recursion: new RecursionBudget(32),
    });
  });

describe("guest call depth", () => {
  it.effect("host cancellation closes work under suspended recursive activations", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let active = 0;
      const wait = Tool.make({
        description: "Wait until interrupted",
        input: Schema.Struct({}),
        output: Schema.Number,
        run: () =>
          Effect.gen(function* () {
            active++;
            yield* Deferred.succeed(started, undefined);
            return yield* Effect.never;
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                active--;
              }),
            ),
          ),
      });
      const fiber = yield* Effect.forkChild(
        CodeMode.execute({
          tools: { host: { wait } },
          code: `
          function* values(n) { if (n) yield* values(n - 1); else yield 1; }
          const iterator = values(20);
          iterator.next();
          async function recurse(n) {
            if (!n) return await tools.host.wait({});
            await 0;
            return await recurse(n - 1);
          }
          return await recurse(20);
        `,
        }),
      );
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      expect(active).toBe(0);
      const reuse = yield* CodeMode.execute({ tools: {}, code: "return 7;" });
      expect(reuse.ok && reuse.value).toBe(7);
    }),
  );

  it.effect("allows ordinary recursion and restores depth after caught throws", () =>
    Effect.gen(function* () {
      const result = yield* run(`
        function sum(n) { return n === 0 ? 0 : n + sum(n - 1); }
        function fail(n) { if (!n) throw 'stop'; return fail(n - 1); }
        for (let i = 0; i < 20; i++) { try { fail(20); } catch {} }
        return sum(20);
      `);
      expect(result).toBe(210);
    }),
  );

  for (const [label, body] of [
    ["functions", "function recur() { return recur(); } recur();"],
    ["async synchronous prefixes", "async function recur() { return recur(); } await recur();"],
    ["callbacks", "function recur() { return [1].map(recur); } recur();"],
    ["generator resumes", "function* recur() { yield* recur(); } recur().next();"],
    ["parameter defaults", "function recur(x = recur()) {} recur();"],
  ]) {
    it.effect(`refuses excessive ${label} with a catchable RangeError and permits reuse`, () =>
      Effect.gen(function* () {
        const result = yield* run(`
          let caught;
          try { ${body} } catch (error) { caught = [error.name, error.message]; }
          function small(n) { return n ? small(n - 1) + 1 : 0; }
          return [caught, small(5)];
        `);
        expect(result).toEqual([["RangeError", "Maximum guest call depth exceeded."], 5]);
      }),
    );
  }

  it.effect("production cap refuses recursion before native stack exhaustion", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        tools: {},
        code: `
        function recurse() { return recurse(); }
        try { recurse(); } catch (error) { return [error.name, error.message]; }
      `,
      });
      expect(result.ok && result.value).toEqual([
        "RangeError",
        "Maximum guest call depth exceeded.",
      ]);
    }),
  );

  for (const [label, body] of [
    ["generators", "function* recurse() { yield* recurse(); } recurse().next();"],
    ["async prefixes", "async function recurse() { return recurse(); } await recurse();"],
    ["callbacks", "function recurse() { return [1].map(recurse); } recurse();"],
    ["defaults", "function recurse(x = recurse()) {} recurse();"],
  ]) {
    it.effect(`production cap protects ${label}`, () =>
      Effect.gen(function* () {
        const result = yield* CodeMode.execute({
          tools: {},
          code: `
        let caught;
        try { ${body} } catch(error) { caught = [error.name, error.message]; }
        function small(n) { return n ? small(n - 1) + 1 : 0; }
        return [caught, small(5)];
      `,
        });
        expect(result.ok && result.value).toEqual([
          ["RangeError", "Maximum guest call depth exceeded."],
          5,
        ]);
      }),
    );
  }

  it.effect("resets ancestry after await instead of counting suspended pagination", () =>
    Effect.gen(function* () {
      const result = yield* run(`
        async function pages(n) {
          if (!n) return 0;
          await 0;
          return 1 + await pages(n - 1);
        }
        return await pages(80);
      `);
      expect(result).toBe(80);
    }),
  );

  for (const [label, boundary] of [
    ["reactions", "return 1 + await Promise.resolve(0).then(() => pages(n - 1));"],
    [
      "iterator awaits",
      "for await (const value of [Promise.resolve(0)]) { return 1 + await pages(n - 1); }",
    ],
  ]) {
    it.effect(`resets ancestry across ${label}`, () =>
      Effect.gen(function* () {
        const result = yield* run(`
        async function pages(n) {
          if (!n) return 0;
          ${boundary}
        }
        return await pages(80);
      `);
        expect(result).toBe(80);
      }),
    );
  }

  it.effect("charges synchronous async-generator delegation on each resume", () =>
    Effect.gen(function* () {
      const result = yield* run(`
        async function* values(n) { yield n; if (n) yield* values(n - 1); }
        try { for await (const value of values(50)) {} }
        catch (error) { return [error.name, error.message]; }
      `);
      expect(result).toEqual(["RangeError", "Maximum guest call depth exceeded."]);
    }),
  );

  it.effect("resets async generator ancestry after awaiting between yields", () =>
    Effect.gen(function* () {
      const result = yield* run(`
      function small(n) { return n ? 1 + small(n - 1) : 0; }
      function resume(n, g) { return n ? resume(n - 1, g) : g.next(); }
      async function* values() { await 0; yield small(20); await 0; yield small(20); }
      const g = values();
      const first = await resume(25, g);
      const second = await resume(25, g);
      return [first.value, second.value];
    `);
      expect(result).toEqual([20, 20]);
    }),
  );

  it.effect("rebases a suspended generator on its resumer rather than its creator", () =>
    Effect.gen(function* () {
      const result = yield* run(`
        function* values() { yield 1; yield 2; }
        function create(n) { return n ? create(n - 1) : values(); }
        function resume(n, generator) { return n ? resume(n - 1, generator) : generator.next(); }
        const a = create(25);
        const first = resume(25, a);
        const second = resume(25, a);
        return [first.value, second.value];
      `);
      expect(result).toEqual([1, 2]);
    }),
  );
});
