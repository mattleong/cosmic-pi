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
import { applyCollapsedStyle, restorePresentationSettings } from "./support/presentation.ts";

/** Fresh registered call and result components per render over one shared renderer state. */
const renderer = <Args, Result>(args: Args, result: Result, isError = false) => {
  const owned = buildCodeModeToolDefinition({
    catalogBudget: 0,
    includePowerShell: false,
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
            if (!expanded && style === "preview") continue;
            for (const issue of summary.issues!.entries) {
              expect(text.split((expanded ? issue.cause : issue.description)!).length - 1).toBe(1);
              for (const diagnostic of issue.diagnostics ?? [])
                expect(text.split(diagnostic).length - 1).toBe(expanded ? 1 : 0);
            }
            for (const notice of summary.notices ?? [])
              expect(text.split(notice.text).length - 1).toBe(expanded ? 1 : 0);
          }
        }
      }
    }
  });

  it("keeps recovery merged onto a body-owned root identity", () => {
    applyCollapsedStyle("compact");
    const repair = "Inspect prior side effects before retrying.";
    const result = {
      content: [{ type: "text", text: "boom" }],
      details: {
        ...callEntryDetails([]),
        compactAttention: {
          version: 2,
          admitted: 0,
          started: 0,
          unsupported: 0,
          observed: 0,
          errors: 0,
          warnings: 0,
          cancelled: 0,
          uncertain: 0,
          incomplete: false,
          notices: [],
          issues: {
            coverage: "unknown",
            entries: [
              {
                operation: "code-mode",
                code: "program-failure",
                severity: "error",
                cause: "boom",
                expandedInResult: true,
                recovery: [{ code: "inspect", text: repair }],
              },
            ],
          },
        },
      },
    };
    const render = renderer({ code: "throw 1", intent: "Root recovery" }, result, true);
    for (const expanded of [false, true, false, true]) {
      const text = render(expanded);
      expect(text.split("boom").length - 1).toBe(expanded ? 1 : 0);
      expect(text.split(repair).length - 1).toBe(expanded ? 1 : 0);
    }
  });

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
            expect(text.includes(diagnostic)).toBe(expanded);
            expect(text.split(diagnostic).length - 1).toBe(expanded ? 1 : 0);
            expect(text.split(instruction).length - 1, text).toBe(expanded ? 1 : 0);
          }
        }
      }).pipe(Effect.provide(CodeModeResults.layer)),
  );
});
