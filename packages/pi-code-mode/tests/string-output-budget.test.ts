import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { executeHarness } from "./support/execute.ts";

const MAX_OUTPUT_BYTES = 51_200;

describe("verbatim string output budget", () => {
  it.effect("delivers exact ASCII and escape-heavy strings through the execution boundary", () =>
    Effect.gen(function* () {
      const { run } = executeHarness({
        cwd: "/project",
        config: { maxOutputBytes: MAX_OUTPUT_BYTES },
      });
      const cases = [
        {
          name: "exact-ascii",
          code: `return "x".repeat(${MAX_OUTPUT_BYTES});`,
          expected: "x".repeat(MAX_OUTPUT_BYTES),
        },
        {
          name: "newlines",
          code: String.raw`return "\n".repeat(26_000);`,
          expected: "\n".repeat(26_000),
        },
      ] as const;

      for (const testCase of cases) {
        const result = yield* Effect.promise(() => run(testCase.code));
        expect(result.content, testCase.name).toStrictEqual([
          { type: "text", text: testCase.expected },
        ]);
        expect(result.details.outputKind, testCase.name).toBe("text");
        expect(result.details.truncated, testCase.name).toBeUndefined();
        expect(result.details.resultId, testCase.name).toBeUndefined();
      }
    }),
  );
});
