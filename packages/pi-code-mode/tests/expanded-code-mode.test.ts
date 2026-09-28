import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { withCodePreviewShell } from "pi-code-previews";
import { renderContextFixture } from "pi-code-previews/testing";
import { opaqueFixture, plainTheme } from "pi-cosmic-core/testing";
import { buildCodeModeToolDefinition } from "../src/tools/controller.ts";
import { CodeModeResults } from "../src/results/service.ts";
import {
  callEntryDetails,
  formatForeignRejection,
  type CodeModeToolDetails,
} from "../src/tools/format.ts";
import { resultReadCompactSummary } from "../src/ui/result-read-summary.ts";
import { executeHarness } from "./support/execute.ts";
import { nestedToolDefinitionsFixture } from "./support/tools.ts";
import { applyCollapsedStyle, restorePresentationSettings } from "./support/presentation.ts";

/** Fresh registered call and result components per render over one shared renderer state. */
const renderer = <Args, Result>(args: Args, result: Result, isError = false) => {
  const owned = buildCodeModeToolDefinition({
    catalogBudget: 0,
    execute: () => Promise.reject(new Error("render-only")),
    startUiTicker: () => () => undefined,
  });
  const tool = withCodePreviewShell(owned, {
    mode: "off",
    compactSummary: owned.compactSummary,
    expandedContent: owned.expandedContent,
  });
  const state = {};
  return (expanded: boolean) => {
    const context = renderContextFixture({
      args,
      state,
      expanded,
      isPartial: false,
      isError,
      executionStarted: true,
    });
    const call = tool.renderCall!(opaqueFixture(args), plainTheme, context);
    const options = { expanded, isPartial: false };
    const body = tool.renderResult!(opaqueFixture(result), options, plainTheme, context);
    return [...call.render(400), ...body.render(400)].join("\n");
  };
};

afterEach(restorePresentationSettings);

describe("registered expanded Code Mode views", () => {
  it("renders retained pages without execution sections, duplicated notices or internal labels", () => {
    for (const style of ["compact", "preview"] as const) {
      applyCollapsedStyle(style);
      for (const originalOutcome of ["succeeded", "failed", "cancelled"] as const) {
        for (const next of [80, null]) {
          const read = {
            status: "page",
            id: "retained-1",
            originalOutcome,
            offset: next === null ? 80 : 0,
            end: next === null ? 87 : 80,
            next,
            total: 87,
          };
          const result = {
            content: [{ type: "text", text: "RAW_PAGE_CONTENT" }],
            details: { toolCalls: [], resultRead: read },
          };
          const render = renderer({ action: "result.read", id: read.id }, result);
          const summary = resultReadCompactSummary(result.details, read.id)!;
          for (const expanded of [false, true, false, true]) {
            const text = render(expanded);
            expect(text.includes("RAW_PAGE_CONTENT")).toBe(expanded);
            expect(text).not.toMatch(
              /Program|Tool orchestration|Calls|program not available|original-execution:|outer-information:/u,
            );
            for (const issue of summary.issues!) {
              const shown = expanded || issue.severity !== "info";
              expect(text.split(issue.message).length - 1).toBe(shown ? 1 : 0);
              expect(text.split(issue.detail!).length - 1).toBe(expanded ? 1 : 0);
            }
          }
        }
      }
    }
  });

  it.effect("orders issues, program, calls and error, keeping calls after the program fails", () =>
    Effect.gen(function* () {
      const { run, retention } = executeHarness({
        definitions: nestedToolDefinitionsFixture({
          read: {
            execute: () =>
              Promise.resolve({ content: [{ type: "text", text: "contents" }], details: {} }),
          },
          bash: { execute: () => Promise.reject(new Error("Command exited with code 1")) },
        }),
        cwd: "/project",
        retainFailureDetails: true,
      });
      const code =
        'await tools.pi.read({path:"notes.md"});\nawait tools.pi.bash({command:"npm test"});';
      const failure = yield* Effect.tryPromise(() => run(code)).pipe(Effect.flip);
      const raw = formatForeignRejection(failure.cause);
      const details = retention.consume("call")!;
      const args = { code, intent: "Run the suite" };
      for (const style of ["compact", "preview"] as const) {
        applyCollapsedStyle(style);
        const render = renderer(args, { content: [{ type: "text", text: raw }], details }, true);
        for (const expanded of [false, true]) {
          const text = render(expanded);
          const at = (marker: string) => text.indexOf(marker);
          const order = [
            ...(expanded ? [at('tools.pi.read({path:"notes.md"})')] : []),
            at("read notes.md"),
            at("Exited with code 1; stopped the program"),
            // Recovery text for the agent follows the diagnostic under its own label.
            ...(expanded ? [at("[ToolFailure]"), at("Agent notes"), at("Do not replay")] : []),
          ];
          expect(
            order.every((index) => index >= 0),
            `${style} ${expanded}`,
          ).toBe(true);
          expect(order, `${style} ${expanded}`).toEqual(order.toSorted((a, b) => a - b));
          expect(text).not.toMatch(/Program stopped|Stopped after/u);
          expect(text.split("Exited with code 1")).toHaveLength(2);
        }
      }
    }),
  );

  it.effect(
    "renders the actual prefixed failure body once in legacy and current expanded paths",
    () =>
      Effect.gen(function* () {
        const results = yield* CodeModeResults;
        let retained: CodeModeToolDetails | undefined;
        const { call } = executeHarness({
          results,
          runPromise: Effect.runPromiseWith(yield* Effect.context<never>()),
          retainFailureDetails: (_id, details) => {
            retained = details;
          },
        });
        const args = {
          code: 'throw new Error("UNCLASSIFIED_FAILURE");',
          intent: "Failure ownership",
        };
        const failure = yield* Effect.tryPromise(() => call(args)).pipe(Effect.flip);
        expect(retained?.resultId).toBeTruthy();
        const raw = formatForeignRejection(failure.cause);
        const diagnostic = raw.split("\n").at(-1)!;
        const instruction = raw.split("\n")[0]!;
        applyCollapsedStyle("compact");
        for (const details of [callEntryDetails([]), retained]) {
          const render = renderer(args, { content: [{ type: "text", text: raw }], details }, true);
          for (const expanded of [false, true, false, true]) {
            const text = render(expanded);
            // The first line may explain the failure collapsed; the full body is expanded-only.
            expect(text).toContain("UNCLASSIFIED_FAILURE");
            expect(text.split(diagnostic).length - 1).toBe(expanded ? 1 : 0);
            for (const line of raw.split("\n").filter((value) => value.trim()))
              if (expanded || line !== instruction) expect(text.includes(line)).toBe(expanded);
          }
        }
      }).pipe(Effect.provide(CodeModeResults.layer)),
  );
});
