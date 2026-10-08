import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import {
  runWorkflowSandbox,
  type WorkflowSandboxHost,
  type WorkflowSandboxOutcome,
} from "../../src/boundary/codemode-sandbox.ts";
import { decodeWorkflowAgentOptions } from "../../src/workflow/options.ts";

interface Recorded {
  readonly agents: Array<{ readonly prompt: string; readonly options: Record<string, string> }>;
  readonly events: Array<Record<string, string>>;
}

const invalid = (message: string) => Effect.fail({ _tag: "InvalidCall", message });

/** Nested workflow bodies by reference; any other reference loads `scan`'s. */
const NESTED = new Map([
  ["deep", "return await parallel([() => workflow('scan', { n: 1 })]);"],
  ["blank", "return await agent('nested', { phase: ' ' });"],
]);
const SCAN = "phase('Inner'); return { args, inner: await agent('child-' + args.n) };";

/** Runs a script body through the sandbox boundary, with recording host members. */
const run = (body: string, args: Schema.Json = null, budget?: number) =>
  Effect.gen(function* () {
    const recorded: Recorded = { agents: [], events: [] };
    const host: WorkflowSandboxHost<never> = {
      agent: (call) => {
        // SAFETY: the prelude always calls the spread agent member as (prompt, options).
        const [prompt, options] = call as [string, Record<string, string>];
        recorded.agents.push({ prompt, options });
        if (prompt.startsWith("reject")) return invalid("invalid agent options");
        if (prompt.startsWith("over"))
          return Effect.succeed({ result: null, outputTokens: 1, refusal: "budget spent" });
        const result = prompt.startsWith("fail") ? null : `done:${prompt}`;
        return Effect.succeed({ result, outputTokens: result === null ? 0 : 5 });
      },
      // SAFETY: the prelude only emits flat string-valued phase and log events.
      event: (event) =>
        Effect.sync(() => void recorded.events.push(event as Record<string, string>)),
      load: (call) => {
        // SAFETY: the prelude always calls the spread load member as (reference, args).
        const [reference] = call as [string, Schema.Json];
        if (reference === "strict")
          return invalid('Args for workflow "strict" don\'t match its meta.args schema.');
        return Effect.succeed({ name: reference, body: NESTED.get(reference) ?? SCAN });
      },
    };
    const outcome = yield* Effect.scoped(
      runWorkflowSandbox(body, args, host, Effect.never, budget),
    );
    return { outcome, ...recorded };
  });

const value = (outcome: WorkflowSandboxOutcome) => {
  if (outcome._tag === "Failed") throw new Error(`${outcome.kind}: ${outcome.failure.message}`);
  return outcome.value;
};

const failure = (outcome: WorkflowSandboxOutcome) => {
  if (outcome._tag === "Completed") throw new Error("Expected the script to fail");
  return outcome.failure;
};

describe("workflow prelude", () => {
  it.effect("passes the current phase to agents and exposes frozen args", () =>
    Effect.gen(function* () {
      const { outcome, agents, events } = yield* run(
        "phase('Find'); const a = await agent('one', { label: 'L' }); const b = await agent('two', { phase: 'Other' });" +
          " let frozen = true; try { args.list.push(2); frozen = false } catch {} return { a, b, args, frozen };",
        { list: [1] },
      );
      expect(value(outcome)).toEqual({
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
      const { outcome, events } = yield* run(
        "const p = await parallel([() => agent('ok'), () => agent('fail'), () => { throw new Error('boom') }]);" +
          "const q = await pipeline([1, 2], (n) => agent('s' + n), (prev, item, index) => item === 2 ? agent('fail') : prev + ':' + index);" +
          "return { p, q };",
      );
      expect(value(outcome)).toEqual({ p: ["done:ok", null, null], q: ["done:s1:0", null] });
      expect(
        events.some(
          (event) => event.level === "warning" && event.message?.includes("boom") === true,
        ),
      ).toBe(true);
    }),
  );

  it.effect("awaits promise items and calls function items in parallel()", () =>
    Effect.gen(function* () {
      const { outcome, agents } = yield* run(
        "return await parallel([agent('started'), () => agent('called'), () => { throw new Error('sync') }]);",
      );
      expect(value(outcome)).toEqual(["done:started", "done:called", null]);
      expect(agents.map((call) => call.prompt)).toEqual(["started", "called"]);
    }),
  );

  it.effect("fails the run for a parallel() item that is neither a function nor a promise", () =>
    Effect.gen(function* () {
      const { outcome, agents } = yield* run(
        "return await pipeline([1], () => parallel([() => agent('first'), 'second']));",
      );
      const error = failure(outcome);
      expect(error.name).toBe("TypeError");
      expect(error.message).toContain("item 1");
      expect(error.message).toContain("() => agent(...)");
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
        const { outcome } = yield* run(`${body} return 'completed';`);
        expect(outcome._tag, body).toBe("Failed");
      }
    }),
  );

  it.effect("lets the script catch an invalid call and keeps other item failures null", () =>
    Effect.gen(function* () {
      const { outcome } = yield* run(
        "let caught; try { await parallel([() => agent('reject')]) } catch (error) { caught = error.message }" +
          " const rest = await pipeline(['fail'], (prompt) => agent(prompt), (found) => found.length);" +
          " const wrapped = await parallel([async () => { try { await agent('reject') } catch { throw new Error('handled') } }]);" +
          " return { caught, rest, wrapped };",
      );
      expect(value(outcome)).toEqual({
        caught: "invalid agent options",
        rest: [null],
        wrapped: [null],
      });
    }),
  );

  it.effect("throws budget refusals, which parallel() and pipeline() turn into null quietly", () =>
    Effect.gen(function* () {
      const { outcome, events } = yield* run(
        "const items = await parallel([() => agent('ok'), () => agent('over 1')]);" +
          " const piped = await pipeline(['over 2'], (prompt) => agent(prompt), () => 'later stage');" +
          " let caught; try { await agent('over 3') } catch (error) { caught = error.message }" +
          " return { items, piped, caught, spent: budget.spent() };",
      );
      // The tokens a refused call spent count before it throws.
      expect(value(outcome)).toEqual({
        items: ["done:ok", null],
        piped: [null],
        caught: "budget spent",
        spent: 8,
      });
      expect(events.filter((event) => event.level === "warning")).toEqual([]);
    }),
  );

  it.effect("fails the run at the script line of an uncaught error", () =>
    Effect.gen(function* () {
      for (const [line, message] of [
        // An uncaught budget refusal, an invalid call and the script's own throw.
        ["await agent('over');", "budget spent"],
        ["await parallel([() => agent('reject')]);", "invalid agent options"],
        ["throw new Error('line three');", "line three"],
      ]) {
        const { outcome } = yield* run(`await agent('ok');\n\n${line}\nreturn 'done';`);
        expect(failure(outcome), line).toMatchObject({
          message,
          stack: expect.stringMatching(/line 3:\d+/u),
        });
      }
    }),
  );

  it.effect("drops a pipeline item when a stage throws and skips its later stages", () =>
    Effect.gen(function* () {
      const { outcome, agents } = yield* run(
        "return await pipeline(['a', 'b'], (x) => { if (x === 'b') throw new Error('no'); return x }, (x) => agent('next-' + x));",
      );
      expect(value(outcome)).toEqual(["done:next-a", null]);
      expect(agents.map((call) => call.prompt)).toEqual(["next-a"]);
    }),
  );

  it.effect("rejects invalid agent calls so the script can see the error", () =>
    Effect.gen(function* () {
      const { outcome } = yield* run(
        "const errors = []; for (const call of [() => agent(''), () => agent('x', 'opts'), () => agent('reject')])" +
          " { try { await call() } catch (e) { errors.push(e.message) } } return errors;",
      );
      expect(value(outcome)).toEqual([
        "agent(prompt) expects a non-empty string prompt",
        "agent(prompt, options) expects an options object",
        "invalid agent options",
      ]);
    }),
  );

  it.effect("refuses nondeterministic time and randomness but allows explicit dates", () =>
    Effect.gen(function* () {
      const { outcome } = yield* run(
        "const failures = []; for (const call of [() => Date.now(), () => new Date(), () => Date(), () => Math.random()])" +
          " { try { call() } catch { failures.push(true) } } return { failures: failures.length, epoch: new Date(0).toISOString() };",
      );
      expect(value(outcome)).toEqual({ failures: 4, epoch: "1970-01-01T00:00:00.000Z" });
    }),
  );

  it.effect("runs one level of nested workflows with prefixed phases", () =>
    Effect.gen(function* () {
      const { outcome, agents } = yield* run("return { child: await workflow('scan', { n: 3 }) };");
      expect(value(outcome)).toEqual({ child: { args: { n: 3 }, inner: "done:child-3" } });
      expect(agents[0]?.options.phase).toBe("▸ scan · Inner");
    }),
  );

  it.effect("leaves a blank agent() phase out in a nested workflow, as at the root", () =>
    Effect.gen(function* () {
      const { agents } = yield* run(
        "await agent('root', { phase: ' ' }); return await workflow('blank');",
      );
      expect(agents.map((call) => call.prompt)).toEqual(["root", "nested"]);
      for (const call of agents)
        expect(
          (yield* decodeWorkflowAgentOptions(call.options)).phase,
          call.prompt,
        ).toBeUndefined();
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
        const { outcome, agents } = yield* run(`${body} return 'completed';`);
        expect(failure(outcome).message, body).toContain(reason);
        expect(agents, body).toEqual([]);
      }
      const { outcome } = yield* run(
        "let caught; try { await workflow('strict') } catch (error) { caught = error.message } return caught;",
      );
      expect(value(outcome)).toContain("meta.args");
    }),
  );

  it.effect("tracks output tokens of finished agents in budget.spent()", () =>
    Effect.gen(function* () {
      const { outcome } = yield* run(
        "await agent('a'); await agent('fail'); return { spent: budget.spent(), total: budget.total, unlimited: budget.remaining() === Infinity };",
      );
      expect(value(outcome)).toEqual({ spent: 5, total: null, unlimited: true });
    }),
  );

  it.effect("counts the start's budget down as agents finish, including nested ones", () =>
    Effect.gen(function* () {
      const { outcome } = yield* run(
        "const before = budget.remaining(); await agent('a'); const child = await workflow('scan', { n: 1 });" +
          " return { total: budget.total, before, after: budget.remaining(), spent: budget.spent() };",
        null,
        8,
      );
      expect(value(outcome)).toEqual({ total: 8, before: 8, after: 0, spent: 10 });
    }),
  );
});
