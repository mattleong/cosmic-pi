import { describe, expect, it } from "@effect/vitest";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { codeModeStateFixture, extensionContextFixture } from "./support/host.ts";
import { nestedToolDefinitionsFixture } from "./support/tools.ts";
import { makeCodeModeToolExecute } from "../src/tools/execution.ts";

const MAX_OUTPUT_BYTES = 51_200;
const context = extensionContextFixture({ cwd: "/project" });

const makeExecute = () => {
  const state = codeModeStateFixture({ maxOutputBytes: MAX_OUTPUT_BYTES });
  return makeCodeModeToolExecute({
    isCurrent: () => true,
    getState: () => state,
    runInSession: (effect, signal) =>
      Effect.runPromise(effect, signal === undefined ? undefined : { signal }),
    definitions: nestedToolDefinitionsFixture({}),
    events: createEventBus(),
    sessionId: "string-output-budget",
  });
};

describe("verbatim string output budget", () => {
  it.effect("delivers exact ASCII and escape-heavy strings through the execution boundary", () =>
    Effect.gen(function* () {
      const execute = makeExecute();
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
        const result = yield* Effect.promise(() =>
          execute(
            `string-output-${testCase.name}`,
            { code: testCase.code },
            undefined,
            undefined,
            context,
          ),
        );
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
