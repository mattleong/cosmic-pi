import { CodemodeSandbox, type CodemodeResult } from "@earendil-works/pi-codemode";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import { WORKFLOW_ARGS_KEY, workflowSandboxSource } from "../../src/workflow/prelude.ts";

interface Recorded {
  readonly agents: Array<{ readonly prompt: string; readonly options: Record<string, string> }>;
  readonly events: Array<Record<string, string>>;
}

/** Runs a script body against the real sandbox with recording host members. */
const run = (
  body: string,
  args?: Schema.Json,
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
          execute: (reference) => ({
            name: String(reference),
            body: "phase('Inner'); return { args, inner: await agent('child-' + args.n) };",
          }),
        },
      ],
    });
    return Effect.promise(() =>
      sandbox.execute(
        workflowSandboxSource(body),
        args === undefined ? {} : { store: { [WORKFLOW_ARGS_KEY]: args } },
      ),
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

  it.effect("tracks output tokens of finished agents in budget.spent()", () =>
    Effect.gen(function* () {
      const { result } = yield* run(
        "await agent('a'); await agent('fail'); return { spent: budget.spent(), total: budget.total };",
      );
      expect(value(result)).toEqual({ spent: 5, total: null });
    }),
  );

  it.effect("keeps script line numbers in error stacks", () =>
    Effect.gen(function* () {
      const { result } = yield* run("const a = 1;\n\nthrow new Error('line three');");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.stack).toContain("codemode.js:3:");
    }),
  );
});
