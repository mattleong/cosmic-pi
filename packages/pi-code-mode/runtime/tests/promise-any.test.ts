import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Schema from "effect/Schema";
import { CodeMode, Tool } from "../src/index.js";

const run = (code: string) => CodeMode.execute({ code, limits: { timeoutMs: 2000 } });

describe("Promise.any and AggregateError", () => {
  it.effect("does not cancel losing tools after a fulfillment", () =>
    Effect.gen(function* () {
      const release = Deferred.makeUnsafe<void>();
      let completed = false;
      let cancelled = false;
      const slow = Tool.make({
        description: "Wait for release",
        input: Schema.Number,
        output: Schema.Number,
        run: (n) =>
          Effect.gen(function* () {
            yield* Deferred.await(release);
            completed = true;
            return n;
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                cancelled = true;
              }),
            ),
          ),
      });
      const unblock = Tool.make({
        description: "Release",
        input: Schema.Number,
        output: Schema.Number,
        run: (n) => Effect.as(Deferred.succeed(release, undefined), n),
      });
      expect(
        yield* CodeMode.execute({
          tools: { slow, unblock },
          limits: { timeoutMs: 2000 },
          code: `const p = tools.slow(9); const value = await Promise.any([p, 1]);
        await tools.unblock(0); return [value, await p, await p];`,
        }),
      ).toMatchObject({ ok: true, value: [1, 9, 9] });
      expect(completed).toBe(true);
      expect(cancelled).toBe(false);
    }),
  );
  it.effect("returns the first fulfillment and accepts supported iterables", () =>
    Effect.gen(function* () {
      expect(
        yield* run(`return [await Promise.any([Promise.reject(1), Promise.resolve(2), 3]),
      await Promise.any(new Set([4, 5])), await Promise.any("ab"),
      await Promise.any(new Map([["key", 6]])),
      await Promise.any(new URLSearchParams("x=7")), await Promise.any([, 8])];`),
      ).toMatchObject({ ok: true, value: [2, 4, "a", ["key", 6], ["x", "7"], null] });
    }),
  );

  it.effect("aggregates original rejection values in input order", () =>
    Effect.gen(function* () {
      expect(
        yield* run(`const first = {}; const second = new TypeError("second");
      const p = Promise.any([(async () => { await 0; throw first; })(), Promise.reject(second)]);
      const error = await p.catch(e => e);
      return [error instanceof Error, error instanceof AggregateError, error instanceof TypeError,
        error.errors[0] === first, error.errors[1] === second, (await p.catch(e => e)) === error,
        (await Promise.any([]).catch(e => e)).errors];`),
      ).toMatchObject({ ok: true, value: [true, true, false, true, true, true, []] });
    }),
  );

  it.effect("constructs aggregate errors with and without new without copying members", () =>
    Effect.gen(function* () {
      expect(
        yield* run(`const item = {}; const items = [item];
      const a = new AggregateError(items, "message", { cause: item }); const b = AggregateError(new Set(items), "other");
      items.push(1);
      return [a.name, a.message, a.errors.length, a.errors[0] === item,
        b instanceof AggregateError, b instanceof Error, b.errors[0] === item,
        Object.keys(a).includes("errors"), new AggregateError("ab").errors,
        a.cause === item, Object.keys(a).includes("cause"), Object.hasOwn(b, "cause")];`),
      ).toMatchObject({
        ok: true,
        value: [
          "AggregateError",
          "message",
          1,
          true,
          true,
          true,
          true,
          false,
          ["a", "b"],
          true,
          false,
          false,
        ],
      });
    }),
  );

  it.effect("continues losing guest work and observes losing rejections", () =>
    Effect.gen(function* () {
      expect(
        yield* run(`const log = []; const loser = (async () => { await 0; await 0; log.push("done"); throw "late"; })();
      const winner = await Promise.any([1, loser]);
      await loser.catch(() => 0); return [winner, log];`),
      ).toMatchObject({ ok: true, value: [1, ["done"]] });
      expect(yield* run(`Promise.any([1, Promise.reject("ignored")]); return 2;`)).toMatchObject({
        ok: true,
        value: 2,
      });
    }),
  );
});
