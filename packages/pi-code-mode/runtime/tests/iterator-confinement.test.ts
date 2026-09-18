import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CodeMode, Tool } from "../src/index.js";

describe("iterator confinement", () => {
  for (const expression of [
    "Symbol.iterator",
    "(function* () { yield 1; })()",
    "(async function* () { yield 1; })()",
  ]) {
    it.effect(`refuses opaque output: ${expression}`, () =>
      Effect.gen(function* () {
        const result = yield* CodeMode.execute({
          tools: {},
          code: `return {nested: ${expression}};`,
        });
        expect(result.ok).toBe(false);
      }),
    );
  }

  it.effect("refuses opaque tool input before dispatch", () =>
    Effect.gen(function* () {
      let called = false;
      const sink = Tool.make({
        description: "Record data",
        input: Schema.Unknown,
        output: Schema.Boolean,
        run: () =>
          Effect.sync(() => {
            called = true;
            return true;
          }),
      });
      const result = yield* CodeMode.execute({
        tools: { sink },
        code: `function* g() { yield 1; } return await tools.sink({iterator: g()});`,
      });
      expect(result.ok).toBe(false);
      expect(called).toBe(false);
    }),
  );

  for (const code of [
    "return Symbol.iterator.constructor;",
    "function* g() {} return g().constructor;",
    "return Symbol.constructor('return process')();",
    "return globalThis.process;",
  ]) {
    it.effect(`keeps authority inaccessible: ${code}`, () =>
      Effect.gen(function* () {
        const result = yield* CodeMode.execute({ tools: {}, code });
        expect(result.ok).toBe(false);
      }),
    );
  }

  it.live("bounds an endless custom iterator under the execution deadline", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        tools: {},
        limits: { timeoutMs: 30 },
        code: `
        const source = { [Symbol.iterator]: () => ({next: () => ({value: 1, done: false})}) };
        return Array.from(source);
      `,
      });
      expect(!result.ok && result.error.kind).toBe("TimeoutExceeded");
    }),
  );
});
