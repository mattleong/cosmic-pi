// Local Array.from mapper compatibility and confinement regressions; see PROVENANCE.md.
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { CodeMode, Tool } from "../src/index.js";
import {
  MAX_GUEST_COLLECTION_ENTRIES,
  setDeadlineClockForTesting,
} from "../src/interpreter/confinement.js";

const run = (code: string) => CodeMode.execute({ code });

describe("Array.from mapper", () => {
  it.effect("supports indexed construction and passes exactly value and index", () =>
    Effect.gen(function* () {
      expect(yield* run("return Array.from({ length: 9 }, (_, i) => i)")).toMatchObject({
        ok: true,
        value: [0, 1, 2, 3, 4, 5, 6, 7, 8],
      });
      expect(
        yield* run(`const from = Array.from;
        return from([4, 8], (value, index, ...rest) => [value, index, rest.length]);`),
      ).toMatchObject({
        ok: true,
        value: [
          [4, 0, 0],
          [8, 1, 0],
        ],
      });
      expect(
        yield* run('return Array.from({ length: 2.9, 1: "x" }, (v, i) => [v === undefined, i])'),
      ).toMatchObject({
        ok: true,
        value: [
          [true, 0],
          [false, 1],
        ],
      });
    }),
  );

  it.effect("maps supported collections, Unicode code points, and builtin callbacks", () =>
    Effect.gen(function* () {
      expect(
        yield* run(`return {
        unicode: Array.from("a😀b", (v, i) => [v, i]),
        map: Array.from(new Map([["a", 2], ["b", 3]]), ([k, v], i) => k + (v + i)),
        set: Array.from(new Set([2, 2, 4]), (v, i) => v + i),
        params: Array.from(new URLSearchParams("a=1&a=2"), ([k, v]) => k + v),
        numbers: Array.from(["1", "2"], Number),
        encoded: Array.from(["a b", "c/d"], encodeURIComponent),
        dates: Array.from([new Date(5)], d => d.getTime())
      };`),
      ).toMatchObject({
        ok: true,
        value: {
          unicode: [
            ["a", 0],
            ["😀", 1],
            ["b", 2],
          ],
          map: ["a2", "b4"],
          set: [2, 5],
          params: ["a1", "a2"],
          numbers: [1, 2],
          encoded: ["a%20b", "c%2Fd"],
          dates: [5],
        },
      });
    }),
  );

  it.effect("observes iterable mutations instead of mapping a snapshot", () =>
    Effect.gen(function* () {
      expect(
        yield* run(`const item = { n: 1 }; const source = [item];
        const mapped = Array.from(source, v => { v.n = 3; return v; });
        return { same: mapped[0] === item, n: source[0].n };`),
      ).toMatchObject({ ok: true, value: { same: true, n: 3 } });
      expect(
        yield* run(`const a = [1, 2];
        return Array.from(a, (v, i) => {
          if (i === 0) { a[1] = 3; a.push(4); }
          return v;
        });`),
      ).toMatchObject({ ok: true, value: [1, 3, 4] });
      expect(
        yield* run(`const a = [1, 2];
        return Array.from(a, (v, i) => { if (i === 0) a.pop(); return v; });`),
      ).toMatchObject({ ok: true, value: [1] });
      expect(
        yield* run(`const m = new Map([["a", 1], ["b", 2]]);
        return Array.from(m, ([k, v], i) => {
          if (i === 0) { m.delete("b"); m.set("c", 3); }
          return [k, v];
        });`),
      ).toMatchObject({
        ok: true,
        value: [
          ["a", 1],
          ["c", 3],
        ],
      });
      expect(
        yield* run(`const s = new Set([1, 2]);
        return Array.from(s, (v, i) => {
          if (i === 0) { s.delete(2); s.add(3); }
          return v;
        });`),
      ).toMatchObject({ ok: true, value: [1, 3] });
      expect(
        yield* run(`const p = new URLSearchParams("a=1");
        return Array.from(p, ([k, v], i) => { if (i === 0) p.append("b", "2"); return k + v; });`),
      ).toMatchObject({ ok: true, value: ["a1", "b2"] });
    }),
  );

  it.effect("captures array-like length once but reads indexed values live", () =>
    Effect.gen(function* () {
      expect(
        yield* run(`const a = { length: 2, 0: "a", 1: "b" };
        return Array.from(a, (v, i) => {
          a.length = 3; a[1] = "changed"; a[2] = "not visited";
          return v;
        });`),
      ).toMatchObject({ ok: true, value: ["a", "changed"] });
      expect(
        yield* run(`let calls = 0;
        const sizes = [NaN, -5, -Infinity].map(length =>
          Array.from({ length }, () => { calls++; }).length);
        return { sizes, calls };`),
      ).toMatchObject({ ok: true, value: { sizes: [0, 0, 0], calls: 0 } });
    }),
  );

  it.effect("restores callback scopes on throws and preserves returned closures", () =>
    Effect.gen(function* () {
      expect(
        yield* run(`const value = "outer"; const seen = []; let caught;
        try { Array.from([1, 2, 3], value => {
          seen.push(value); if (value === 2) throw new Error("mapper failed"); return value;
        }); } catch (e) { caught = e.message; }
        const closures = Array.from({ length: 3 }, (_, i) => () => i);
        return { value, seen, caught, closures: closures.map(f => f()) };`),
      ).toMatchObject({
        ok: true,
        value: {
          value: "outer",
          seen: [1, 2],
          caught: "mapper failed",
          closures: [0, 1, 2],
        },
      });
    }),
  );

  it.effect("accepts an undefined mapper and rejects invalid callbacks even for empty inputs", () =>
    Effect.gen(function* () {
      expect(yield* run("return Array.from([1, 2], undefined, undefined)")).toMatchObject({
        ok: true,
        value: [1, 2],
      });
      for (const mapper of ["null", "0", '"not callable"', "{}"])
        expect(yield* run(`return Array.from([], ${mapper})`)).toMatchObject({ ok: false });
      expect(yield* run("return Array.from([], x => x, {})")).toMatchObject({
        ok: false,
        error: { kind: "UnsupportedSyntax" },
      });
    }),
  );

  it.effect("keeps returned tool promises usable without awaiting them during mapping", () =>
    Effect.gen(function* () {
      const release = Deferred.makeUnsafe<void>();
      const started: number[] = [];
      const echo = Tool.make({
        description: "Echo after all mapper calls have started",
        input: Schema.Struct({ index: Schema.Number }),
        output: Schema.Number,
        run: ({ index }) =>
          Effect.gen(function* () {
            started.push(index);
            if (started.length === 3) yield* Deferred.succeed(release, undefined);
            yield* Deferred.await(release);
            return index;
          }),
      });
      const result = yield* CodeMode.execute({
        tools: { echo },
        code: `return await Promise.all(Array.from({ length: 3 }, (_, index) => tools.echo({ index })));`,
      });
      expect(result).toMatchObject({ ok: true, value: [0, 1, 2] });
      expect(started).toEqual([0, 1, 2]);
    }),
  );

  it.effect("interrupts awaited mapper work when the outer deadline expires", () =>
    Effect.gen(function* () {
      const started = Deferred.makeUnsafe<void>();
      const interrupted = Deferred.makeUnsafe<void>();
      const wait = Tool.make({
        description: "Wait until interrupted",
        input: Schema.Struct({}),
        output: Schema.String,
        run: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(interrupted, undefined)),
          ),
      });
      const fiber = yield* CodeMode.execute({
        tools: { wait },
        limits: { timeoutMs: 1_000 },
        code: "return await Promise.all(Array.from([1, 2], async () => await tools.wait({})));",
      }).pipe(Effect.forkChild);
      yield* Effect.raceFirst(Deferred.await(started), Fiber.join(fiber));
      yield* TestClock.adjust("1 second");
      expect(yield* Fiber.join(fiber)).toMatchObject({
        ok: false,
        error: { kind: "TimeoutExceeded" },
      });
      yield* Deferred.await(interrupted);
    }),
  );

  it.effect("validates sources before mapper tool effects and admits the exact size limit", () =>
    Effect.gen(function* () {
      let calls = 0;
      const touch = Tool.make({
        description: "Record a mapper side effect",
        input: Schema.Struct({}),
        output: Schema.Number,
        run: () => Effect.sync(() => ++calls),
      });
      for (const source of [
        `{ length: ${MAX_GUEST_COLLECTION_ENTRIES + 1} }`,
        "{ length: Infinity }",
        "[() => 1]",
        `"x".repeat(${MAX_GUEST_COLLECTION_ENTRIES + 1})`,
      ]) {
        expect(
          yield* CodeMode.execute({
            tools: { touch },
            code: `return Array.from(${source}, () => tools.touch({}));`,
          }),
        ).toMatchObject({ ok: false, error: { kind: "InvalidDataValue" } });
      }
      expect(calls).toBe(0);
      expect(
        yield* run(
          `return Array.from({ length: ${MAX_GUEST_COLLECTION_ENTRIES} }, Boolean).length`,
        ),
      ).toMatchObject({ ok: true, value: MAX_GUEST_COLLECTION_ENTRIES });
    }),
  );

  it.effect("checks the cooperative deadline during builtin mapping", () =>
    Effect.gen(function* () {
      let now = 0;
      setDeadlineClockForTesting(() => now++);
      try {
        expect(
          yield* CodeMode.execute({
            code: "return Array.from({ length: 1000 }, Boolean).length;",
            limits: { timeoutMs: 100 },
          }),
        ).toMatchObject({ ok: false, error: { kind: "TimeoutExceeded" } });
      } finally {
        setDeadlineClockForTesting(undefined);
      }
    }),
  );

  it.effect(
    "bounds self-extending iteration before invoking an over-limit mapper",
    () =>
      Effect.gen(function* () {
        const result = yield* run(`const s = new Set([0]); let calls = 0;
        try {
          Array.from(s, v => { calls++; s.delete(v); s.add(v + 1); return v; });
        } catch (e) { return { calls, refused: e.message.includes("Array.from") }; }
        return "unexpected completion";`);
        expect(result).toMatchObject({
          ok: true,
          value: { calls: MAX_GUEST_COLLECTION_ENTRIES, refused: true },
        });
      }),
    { timeout: 30_000 },
  );
});
