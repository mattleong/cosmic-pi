import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { CodeMode } from "../src/index.js";

describe("labeled completions", () => {
  it.effect("routes chained loop labels without closing an iterator on a same-loop continue", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        tools: {},
        code: `
        const trace = [];
        let count = 0;
        const source = { [Symbol.asyncIterator]: () => ({
          next: async () => ({ done: count === 3, value: count++ }),
          return: async () => { trace.push('closed'); return {done: true}; }
        }) };
        first: second: for await (const value of source) {
          try { if (value < 2) continue first; break second; }
          finally { trace.push(value); }
        }
        return trace;
      `,
      });
      expect(result).toMatchObject({
        ok: true,
        value: [0, 1, 2, "closed"],
      });
    }),
  );
  it.effect("routes outer continue and break through finally", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        tools: {},
        code: `
        const trace = [];
        outer: for (let i = 0; i < 3; i++) {
          for (let j = 0; j < 2; j++) {
            try { if (i === 0) continue outer; break outer; }
            finally { trace.push(i); }
          }
        }
        done: { trace.push('block'); break done; trace.push('unreachable'); }
        return trace;
      `,
      });
      expect(result.ok && result.value).toEqual([0, 1, "block"]);
    }),
  );

  it.effect("lets finally replace a pending labeled completion", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        tools: {},
        code: `
        const trace = [];
        outer: for (let i = 0; i < 3; i++) {
          try { continue outer; } finally { trace.push(i); break outer; }
        }
        return trace;
      `,
      });
      expect(result.ok && result.value).toEqual([0]);
    }),
  );
});
