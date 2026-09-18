import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CodeMode, Tool } from "../src/index.js";

describe("assignment references", () => {
  it.effect("resolves the member before the RHS and captures compound values before mutation", () =>
    Effect.gen(function* () {
      const trace: string[] = [];
      const mark = Tool.make({
        description: "Record evaluation",
        input: Schema.String,
        output: Schema.String,
        run: (s) =>
          Effect.sync(() => {
            trace.push(s);
            return s;
          }),
      });
      const result = yield* CodeMode.execute({
        tools: { mark },
        code: `
      const box = {x: 2};
      async function target() { await tools.mark('target'); return box; }
      async function key() { await tools.mark('key'); return 'x'; }
      async function rhs() { await tools.mark('rhs'); box.x = 40; return 3; }
      (await target())[await key()] += await rhs();
      let n = 2; function change() { n = 40; return 3; } n += change();
      return [box.x, n];
    `,
      });
      expect(result).toMatchObject({ ok: true, value: [5, 5] });
      expect(trace).toEqual(["target", "key", "rhs"]);
    }),
  );

  it.effect("simple assignment resolves once without reading the field", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        tools: {},
        code: `
      let calls = 0, rhs = 0; const box = {};
      function target() { calls++; return box; }
      target().missing = ++rhs;
      return [box.missing, calls, rhs];
    `,
      });
      expect(result).toMatchObject({ ok: true, value: [1, 1, 1] });
    }),
  );

  for (const base of ["null", "undefined", "'text'"]) {
    for (const operator of ["=", "+="]) {
      it.effect(`matches native failure timing for ${base}[key()] ${operator} rhs()`, () =>
        Effect.gen(function* () {
          const code = `
            const trace = [];
            function target() { trace.push('target'); return ${base}; }
            function key() { trace.push('key'); return 'length'; }
            function rhs() { trace.push('rhs'); return 1; }
            try { target()[key()] ${operator} rhs(); } catch (e) { trace.push('caught'); }
            return trace;
          `;
          const native = new Function(`"use strict"; ${code}`)();
          expect(native).toEqual(
            operator === "=" || base === "'text'"
              ? ["target", "key", "rhs", "caught"]
              : ["target", "key", "caught"],
          );
          expect(yield* CodeMode.execute({ code })).toMatchObject({ ok: true, value: native });
        }),
      );
    }
  }

  for (const failure of ["target", "key"]) {
    for (const operator of ["=", "+="]) {
      it.effect(`matches native ${failure} evaluation throws before ${operator} RHS`, () =>
        Effect.gen(function* () {
          const code = `
            const trace = [];
            function target() { trace.push('target'); ${failure === "target" ? "throw 'target';" : "return {};"} }
            function key() { trace.push('key'); throw 'key'; }
            function rhs() { trace.push('rhs'); return 1; }
            try { target()[key()] ${operator} rhs(); } catch (e) { trace.push(e); }
            return trace;
          `;
          const native = new Function(`"use strict"; ${code}`)();
          expect(native).toEqual(
            failure === "target" ? ["target", "target"] : ["target", "key", "key"],
          );
          expect(yield* CodeMode.execute({ code })).toMatchObject({ ok: true, value: native });
        }),
      );
    }
  }

  it.effect("intentionally refuses blocked keys before RHS evaluation", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        code: `
          const trace = [], box = {};
          function key() { trace.push('key'); return 'constructor'; }
          function rhs() { trace.push('rhs'); return 1; }
          try { box[key()] = rhs(); } catch (e) { trace.push('caught'); }
          return trace;
        `,
      });
      expect(result).toMatchObject({ ok: true, value: ["key", "caught"] });
    }),
  );

  it.effect("logical assignments short circuit and preserve their original reference", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        tools: {},
        code: `
      let calls = 0; const box = {x: 0};
      function target() { calls++; return box; }
      target().x &&= 9; target().x ||= 4; target().x ??= 8;
      return [box.x, calls];
    `,
      });
      expect(result).toMatchObject({ ok: true, value: [4, 3] });
    }),
  );
});
