import { CodemodeSandbox, type CodemodeResult } from "@earendil-works/pi-codemode";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import {
  WORKFLOW_ARGS_KEY,
  WORKFLOW_BUDGET_KEY,
  workflowSandboxSource,
} from "../../src/workflow/prelude.ts";

interface Recorded {
  readonly agents: Array<{ readonly prompt: string; readonly options: Record<string, string> }>;
  readonly events: Array<Record<string, string>>;
}

/** Runs a script body against the real sandbox with recording host members. */
const run = (
  body: string,
  args?: Schema.Json,
  budget?: number,
): Effect.Effect<{ readonly result: CodemodeResult } & Recorded> =>
  Effect.suspend(() => {
    const recorded: Recorded = { agents: [], events: [] };
    const sandbox = new CodemodeSandbox({
      timeoutMs: 20_000,
      globals: [
        {
          name: "__workflow.agent",
          spread: true,
          execute: (call) => {
            // SAFETY: the prelude always calls the spread agent member as (prompt, options).
            const [prompt, options] = call as [string, Record<string, string>];
            recorded.agents.push({ prompt, options });
            if (prompt.startsWith("reject"))
              return Promise.reject(new Error("invalid agent options"));
            if (prompt.startsWith("over"))
              return Promise.resolve({ result: null, outputTokens: 1, refusal: "budget spent" });
            const result = prompt.startsWith("fail") ? null : `done:${prompt}`;
            return Promise.resolve({ result, outputTokens: result === null ? 0 : 5 });
          },
        },
        {
          name: "__workflow.event",
          execute: (event) => {
            // SAFETY: the prelude only emits flat string-valued phase and log events.
            recorded.events.push(event as Record<string, string>);
            return undefined;
          },
        },
        {
          name: "__workflow.load",
          spread: true,
          execute: (call) => {
            // SAFETY: the prelude always calls the spread load member as (reference, args).
            const [reference] = call as [string, Schema.Json];
            if (reference === "strict")
              return Promise.reject(
                new Error('Args for workflow "strict" don\'t match its meta.args schema.'),
              );
            const body =
              reference === "deep"
                ? "return await parallel([() => workflow('scan', { n: 1 })]);"
                : "phase('Inner'); return { args, inner: await agent('child-' + args.n) };";
            return Promise.resolve({ name: reference, body });
          },
        },
      ],
    });
    return Effect.promise(() =>
      sandbox.execute(workflowSandboxSource(body), {
        store: {
          ...(args !== undefined && { [WORKFLOW_ARGS_KEY]: args }),
          ...(budget !== undefined && { [WORKFLOW_BUDGET_KEY]: budget }),
        },
      }),
    ).pipe(
      Effect.map((result) => ({ result, ...recorded })),
      Effect.ensuring(Effect.promise(() => sandbox.close())),
    );
  });

const value = (result: CodemodeResult) => {
  if (!result.ok) throw new Error(`${result.error.kind}: ${result.error.message}`);
  return result.value;
};

describe("workflow prelude", () => {
  it.effect("passes the current phase to agents and exposes frozen args", () =>
    Effect.gen(function* () {
      const { result, agents, events } = yield* run(
        "phase('Find'); const a = await agent('one', { label: 'L' }); const b = await agent('two', { phase: 'Other' });" +
          " let frozen = true; try { args.list.push(2); frozen = false } catch {} return { a, b, args, frozen };",
        { list: [1] },
      );
      expect(value(result)).toEqual({
        a: "done:one",
        b: "done:two",
        args: { list: [1] },
        frozen: true,
      });
      expect(agents.map((call) => call.options)).toEqual([
        { label: "L", phase: "Find" },
        { phase: "Other" },
      ]);
      expect(events).toEqual([{ type: "phase", title: "Find" }]);
    }),
  );

  it.effect("turns failed agents and throwing items into null without failing the batch", () =>
    Effect.gen(function* () {
      const { result, events } = yield* run(
        "const p = await parallel([() => agent('ok'), () => agent('fail'), () => { throw new Error('boom') }]);" +
          "const q = await pipeline([1, 2], (n) => agent('s' + n), (prev, item, index) => item === 2 ? agent('fail') : prev + ':' + index);" +
          "return { p, q };",
      );
      expect(value(result)).toEqual({ p: ["done:ok", null, null], q: ["done:s1:0", null] });
      expect(
        events.some(
          (event) => event.level === "warning" && event.message?.includes("boom") === true,
        ),
      ).toBe(true);
    }),
  );

  it.effect("awaits promise items and calls function items in parallel()", () =>
    Effect.gen(function* () {
      const { result, agents } = yield* run(
        "return await parallel([agent('started'), () => agent('called'), () => { throw new Error('sync') }]);",
      );
      expect(value(result)).toEqual(["done:started", "done:called", null]);
      expect(agents.map((call) => call.prompt)).toEqual(["started", "called"]);
    }),
  );

  it.effect("fails the run for a parallel() item that is neither a function nor a promise", () =>
    Effect.gen(function* () {
      const { result, agents } = yield* run(
        "return await pipeline([1], () => parallel([() => agent('first'), 'second']));",
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.name).toBe("TypeError");
        expect(result.error.message).toContain("item 1");
        expect(result.error.message).toContain("() => agent(...)");
      }
      // The batch is checked before any item starts.
      expect(agents).toEqual([]);
    }),
  );

  it.effect("fails the run for an invalid agent() call inside parallel() or pipeline()", () =>
    Effect.gen(function* () {
      for (const body of [
        "await parallel([() => agent('ok'), () => agent('reject')]);",
        "await parallel([agent('reject')]);",
        "await pipeline([1], () => agent(''));",
        "await parallel([async () => { const value = await agent('reject'); return value; }]);",
      ]) {
        const { result } = yield* run(`${body} return 'completed';`);
        expect(result.ok, body).toBe(false);
      }
    }),
  );

  it.effect("lets the script catch an invalid call and keeps other item failures null", () =>
    Effect.gen(function* () {
      const { result } = yield* run(
        "let caught; try { await parallel([() => agent('reject')]) } catch (error) { caught = error.message }" +
          " const rest = await pipeline(['fail'], (prompt) => agent(prompt), (found) => found.length);" +
          " const wrapped = await parallel([async () => { try { await agent('reject') } catch { throw new Error('handled') } }]);" +
          " return { caught, rest, wrapped };",
      );
      expect(value(result)).toEqual({
        caught: "invalid agent options",
        rest: [null],
        wrapped: [null],
      });
    }),
  );

  it.effect("throws budget refusals, which parallel() and pipeline() turn into null quietly", () =>
    Effect.gen(function* () {
      const { result, events } = yield* run(
        "const items = await parallel([() => agent('ok'), () => agent('over 1')]);" +
          " const piped = await pipeline(['over 2'], (prompt) => agent(prompt), () => 'later stage');" +
          " let caught; try { await agent('over 3') } catch (error) { caught = error.message }" +
          " return { items, piped, caught, spent: budget.spent() };",
      );
      // The tokens a refused call spent count before it throws.
      expect(value(result)).toEqual({
        items: ["done:ok", null],
        piped: [null],
        caught: "budget spent",
        spent: 8,
      });
      expect(events.filter((event) => event.level === "warning")).toEqual([]);
    }),
  );

  it.effect("fails the run for an uncaught budget refusal at the script line of its call", () =>
    Effect.gen(function* () {
      const { result } = yield* run("await agent('ok');\n\nawait agent('over');\nreturn 'done';");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe("budget spent");
        expect(result.error.stack).toMatch(/:3:\d+/u);
      }
    }),
  );

  it.effect("reports the script line of an invalid agent() call", () =>
    Effect.gen(function* () {
      const { result } = yield* run("const a = 1;\n\nawait parallel([() => agent('reject')]);");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe("invalid agent options");
        expect(result.error.stack).toMatch(/:3:\d+/u);
      }
    }),
  );

  it.effect("drops a pipeline item when a stage throws and skips its later stages", () =>
    Effect.gen(function* () {
      const { result, agents } = yield* run(
        "return await pipeline(['a', 'b'], (x) => { if (x === 'b') throw new Error('no'); return x }, (x) => agent('next-' + x));",
      );
      expect(value(result)).toEqual(["done:next-a", null]);
      expect(agents.map((call) => call.prompt)).toEqual(["next-a"]);
    }),
  );

  it.effect("rejects invalid agent calls so the script can see the error", () =>
    Effect.gen(function* () {
      const { result } = yield* run(
        "const errors = []; for (const call of [() => agent(''), () => agent('x', 'opts'), () => agent('reject')])" +
          " { try { await call() } catch (e) { errors.push(e.message) } } return errors;",
      );
      expect(value(result)).toEqual([
        "agent(prompt) expects a non-empty string prompt",
        "agent(prompt, options) expects an options object",
        "invalid agent options",
      ]);
    }),
  );

  it.effect("refuses nondeterministic time and randomness but allows explicit dates", () =>
    Effect.gen(function* () {
      const { result } = yield* run(
        "const failures = []; for (const call of [() => Date.now(), () => new Date(), () => Date(), () => Math.random()])" +
          " { try { call() } catch { failures.push(true) } } return { failures: failures.length, epoch: new Date(0).toISOString() };",
      );
      expect(value(result)).toEqual({ failures: 4, epoch: "1970-01-01T00:00:00.000Z" });
    }),
  );

  it.effect("runs one level of nested workflows with prefixed phases", () =>
    Effect.gen(function* () {
      const { result, agents } = yield* run("return { child: await workflow('scan', { n: 3 }) };");
      expect(value(result)).toEqual({ child: { args: { n: 3 }, inner: "done:child-3" } });
      expect(agents[0]?.options.phase).toBe("▸ scan · Inner");
    }),
  );

  it.effect("fails the run for an invalid workflow() call, even inside parallel()", () =>
    Effect.gen(function* () {
      for (const [body, reason] of [
        ["await workflow('strict', { n: 1 });", "meta.args"],
        ["await parallel([() => workflow('strict')]);", "meta.args"],
        ["await pipeline([1], (n) => workflow('strict', { n }));", "meta.args"],
        // Args that aren't JSON, and a second level of nesting, are invalid calls too.
        ["await parallel([() => workflow('scan', 1n)]);", "BigInt"],
        ["await parallel([() => workflow('deep')]);", "one level deep"],
      ] as const) {
        const { result, agents } = yield* run(`${body} return 'completed';`);
        expect(result.ok, body).toBe(false);
        if (!result.ok) expect(result.error.message, body).toContain(reason);
        expect(agents, body).toEqual([]);
      }
      const { result } = yield* run(
        "let caught; try { await workflow('strict') } catch (error) { caught = error.message } return caught;",
      );
      expect(value(result)).toContain("meta.args");
    }),
  );

  it.effect("tracks output tokens of finished agents in budget.spent()", () =>
    Effect.gen(function* () {
      const { result } = yield* run(
        "await agent('a'); await agent('fail'); return { spent: budget.spent(), total: budget.total, unlimited: budget.remaining() === Infinity };",
      );
      expect(value(result)).toEqual({ spent: 5, total: null, unlimited: true });
    }),
  );

  it.effect("counts the start's budget down as agents finish, including nested ones", () =>
    Effect.gen(function* () {
      const { result } = yield* run(
        "const before = budget.remaining(); await agent('a'); const child = await workflow('scan', { n: 1 });" +
          " return { total: budget.total, before, after: budget.remaining(), spent: budget.spent() };",
        undefined,
        8,
      );
      expect(value(result)).toEqual({ total: 8, before: 8, after: 0, spent: 10 });
    }),
  );

  it.effect("keeps script line numbers in error stacks", () =>
    Effect.gen(function* () {
      const { result } = yield* run("const a = 1;\n\nthrow new Error('line three');");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.stack).toMatch(/:3:\d+/u);
    }),
  );
});
