import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { workflowToolExample } from "../../src/tools/workflow.ts";
import { parseWorkflowScript } from "../../src/workflow/script.ts";
import {
  ANSWERS,
  guideExamples,
  readGuide,
  runProblems,
  scriptOf,
} from "./fixtures/authoring-guide.ts";

const SCRIPT_FENCE = /^\x60\x60\x60(?:js|javascript|ts|typescript)\b.*$/gmu;

describe("workflow authoring guide", () => {
  it.effect("marks every script block as a complete example or a fragment", () =>
    Effect.gen(function* () {
      const markdown = yield* readGuide;
      const fences = [...markdown.matchAll(SCRIPT_FENCE)].map(([fence]) => fence);
      expect(fences.length).toBeGreaterThan(0);
      expect(fences.filter((fence) => fence !== "```js" && fence !== "```js fragment")).toEqual([]);
      expect(guideExamples(markdown).some((example) => !example.fragment)).toBe(true);
    }),
  );

  it.effect("has examples that all parse as workflow scripts", () =>
    Effect.gen(function* () {
      const examples = guideExamples(yield* readGuide);
      const problems = yield* Effect.forEach(examples, (example) =>
        parseWorkflowScript(scriptOf(example)).pipe(
          Effect.match({
            onSuccess: () => [],
            onFailure: (error) => [`line ${example.line}: ${error.message}`],
          }),
        ),
      );
      expect(problems.flat()).toEqual([]);
    }),
  );

  it.live(
    "runs its complete examples and the tool's example against the real call checks",
    () =>
      Effect.gen(function* () {
        const complete = guideExamples(yield* readGuide).filter((example) => !example.fragment);
        const scripts = [
          ...complete.map((example) => ({ name: `line ${example.line}`, source: example.code })),
          { name: "the tool description's example", source: workflowToolExample },
        ];
        const problems = yield* Effect.forEach(scripts, ({ name, source }) =>
          Effect.forEach(ANSWERS, (answers) => runProblems(name, source, answers)),
        );
        expect(problems.flat(2)).toEqual([]);
      }),
    30_000,
  );
});
