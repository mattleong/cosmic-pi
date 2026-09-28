import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { CodeMode } from "../src/index.js";

const locationOf = (code: string) =>
  Effect.map(CodeMode.execute({ code }), (result) =>
    result.ok ? undefined : result.error.location,
  );

describe("source locations", () => {
  it.effect("point at the model's own lines and columns through comments and types", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [string, { line: number; column: number }]> = [
        ["const x = 1;\n\n\n// comment\n\nreturn x.a.b", { line: 6, column: 8 }],
        ["const a = 1; const b = 2; const c = null; c.x;", { line: 1, column: 43 }],
        ["if (true) {\n  if (true) {\n    return null.d;\n  }\n}", { line: 3, column: 12 }],
        [
          "type T = {\n  a: string;\n  b: number;\n};\nconst x: T | null = null;\nreturn x.c.d",
          { line: 6, column: 8 },
        ],
        ["const x: Record<string, number> = {}; return x.q.r", { line: 1, column: 46 }],
        ["enum E { A, B }\nreturn E.A.x.y", { line: 2, column: 8 }],
        ["let x = 1;\nconst y = 2;\nlet x = 3;", { line: 3, column: 5 }],
      ];
      for (const [code, location] of cases) expect(yield* locationOf(code), code).toEqual(location);
    }),
  );
});
