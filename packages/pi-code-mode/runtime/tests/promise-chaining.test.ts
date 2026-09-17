import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { CodeMode, Tool } from "../src/index.js";

const run = (code: string) => CodeMode.execute({ code, limits: { timeoutMs: 2000 } });
// Test-only native oracle: execute the same fixed fixtures, never model-supplied source.
// These fixtures fulfill; unexpected rejection is a test defect.
const NativeFixtureResult = Schema.Union([Schema.Finite, Schema.Array(Schema.String)]);
const runNative = (code: string) =>
  Promise.resolve<unknown>(new Function(`return (async () => { ${code} })()`)()).then(
    Schema.decodeUnknownSync(NativeFixtureResult),
  );

describe("promise chaining", () => {
  it.effect("uses existing builtin, tool and bound intrinsic callables as handlers", () =>
    Effect.gen(function* () {
      const echo = Tool.make({
        description: "Echo",
        input: Schema.Number,
        output: Schema.Number,
        run: Effect.succeed,
      });
      expect(
        yield* CodeMode.execute({
          tools: { echo },
          code: `const list = [1, 2];
      return [await Promise.resolve({ n: 1 }).then(JSON.stringify),
        await Promise.reject(4).catch(String), await Promise.resolve(8).then(tools.echo),
        await Promise.resolve(3).finally(list.pop), list, String(Promise.resolve(1)),
        (await Promise.resolve("message").then(TypeError)) instanceof TypeError];`,
        }),
      ).toMatchObject({ ok: true, value: ['{"n":1}', "4", 8, 3, [1], "[object Promise]", true] });
    }),
  );

  it.effect("matches native race winners across reaction and adoption depths", () =>
    Effect.gen(function* () {
      const forms = (n: number) => [
        `Promise.resolve(${n})`,
        `Promise.resolve().then(() => ${n})`,
        `Promise.reject(0).catch(() => ${n})`,
        `Promise.resolve(${n}).finally(() => 0)`,
        `Promise.resolve().then(() => Promise.resolve(${n}))`,
        `Promise.resolve().then(async () => { await 0; return ${n}; })`,
        `Promise.any([${n}, ${n}])`,
        `Promise.reject(0).finally(() => 0).catch(() => ${n})`,
      ];
      for (const left of forms(1))
        for (const right of forms(2)) {
          const code = `return await Promise.race([${left}, ${right}]);`;
          const expected = yield* Effect.promise(() => runNative(code));
          expect(yield* run(code), `${left} versus ${right}`).toMatchObject({
            ok: true,
            value: expected,
          });
        }
    }),
  );

  it.effect("owns handler tools through race cancellation, deadlines and host interruption", () =>
    Effect.gen(function* () {
      let interrupted = 0;
      let started = Deferred.makeUnsafe<void>();
      const slow = Tool.make({
        description: "Wait",
        input: Schema.Number,
        output: Schema.Number,
        run: () =>
          Effect.andThen(Deferred.succeed(started, undefined), Effect.never).pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted++;
              }),
            ),
          ),
      });
      expect(
        yield* CodeMode.execute({
          tools: { slow },
          limits: { timeoutMs: 2000 },
          code: `const p = Promise.resolve().then(() => { tools.slow(1); return 2; });
        await p; return await Promise.race([3, p]);`,
        }),
      ).toMatchObject({ ok: true, value: 3 });
      expect(interrupted).toBe(1);
      const timed = yield* CodeMode.execute({
        tools: { slow },
        limits: { timeoutMs: 30 },
        code: `return await Promise.resolve().finally(() => { tools.slow(1); while (true) {} });`,
      });
      expect(timed.ok).toBe(false);
      expect(interrupted).toBe(2);
      started = Deferred.makeUnsafe<void>();
      const fiber = yield* Effect.forkChild(
        CodeMode.execute({
          tools: { slow },
          code: `return await Promise.resolve().then(() => tools.slow(1));`,
        }),
      );
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      expect(interrupted).toBe(3);
    }),
  );
  it.effect("preserves values, errors, repeated observations and default handlers", () =>
    Effect.gen(function* () {
      expect(
        yield* run(`const value = { n: 1 }; const error = new TypeError("bad");
      const p = Promise.resolve(value).then(null).catch(() => 0);
      const q = Promise.reject(error).then(0, false).catch(e => e);
      return [(await p) === value, (await p) === value, (await q) === error,
        (await q) instanceof TypeError, await Promise.resolve(2).then(n => n + 1),
        await Promise.resolve(9).then(tools)];`),
      ).toMatchObject({ ok: true, value: [true, true, true, true, 3, 9] });
    }),
  );

  it.effect("retains ancestor and reentrant race cancellation guards in handlers", () =>
    Effect.gen(function* () {
      expect(
        yield* run(
          `let p; p = Promise.resolve().then(() => Promise.race([p, 1])); return await p;`,
        ),
      ).toMatchObject({ ok: true, value: 1 });
      expect(
        yield* run(`let p, q;
        p = Promise.resolve().then(() => Promise.race([q, 1]));
        q = Promise.resolve().then(() => Promise.race([p, 2]));
        return await Promise.race([p, q, 3]);`),
      ).toMatchObject({ ok: true, value: 3 });
    }),
  );

  it.effect("adopts callbacks and rejects direct self resolution", () =>
    Effect.gen(function* () {
      expect(
        yield* run(`let p; p = Promise.resolve().then(() => p);
      const self = await p.catch(e => e instanceof TypeError);
      return [self, await Promise.resolve(2).then(async n => { await 0; return n + 3; }),
        await Promise.resolve().then(() => { throw "bad"; }).catch(e => e)];`),
      ).toMatchObject({ ok: true, value: [true, 5, "bad"] });
    }),
  );

  it.effect("finally awaits cleanup, preserves the source and permits overrides", () =>
    Effect.gen(function* () {
      expect(
        yield* run(`const value = {}; const error = {}; let seen = 0;
      const a = await Promise.resolve(value).finally((x = 7) => { seen = x; return 99; });
      const b = await Promise.reject(error).finally(async () => { await 0; }).catch(e => e);
      const c = await Promise.resolve(1).finally(() => Promise.reject("cleanup")).catch(e => e);
      const d = await Promise.reject(1).finally(() => { throw "override"; }).catch(e => e);
      return [a === value, b === error, seen, c, d];`),
      ).toMatchObject({ ok: true, value: [true, true, 7, "cleanup", "override"] });
    }),
  );

  it.effect("does not observe the returned chain merely by observing its source", () =>
    Effect.gen(function* () {
      for (const code of [
        `Promise.reject("lost").then(); return 1;`,
        `Promise.resolve().then(() => { throw "lost"; }); return 1;`,
        `Promise.reject("lost").finally(() => 1); return 1;`,
      ]) {
        const result = yield* run(code);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.message).toContain("lost");
      }
    }),
  );

  it.effect("matches native FIFO reactions, adoption and finally scheduling", () =>
    Effect.gen(function* () {
      const code = `const log = []; const p = Promise.resolve(1);
      const a = p.then(n => { log.push("a"); return Promise.resolve(n); }).then(() => log.push("adopt"));
      const b = p.then(async () => { log.push("b"); await 0; log.push("resume"); }).finally(() => log.push("finally"));
      const c = p.then(() => log.push("c")).then(() => log.push("plain"));
      await Promise.all([a, b, c]); return log;`;
      const native = yield* Effect.promise(() => runNative(code));
      expect(yield* run(code)).toMatchObject({ ok: true, value: native });
    }),
  );
});
