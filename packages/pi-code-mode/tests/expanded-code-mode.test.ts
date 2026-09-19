import { createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { withCodePreviewShell } from "pi-code-previews";
import * as codePreviews from "pi-code-previews";
import { vi } from "vitest";
import {
  codePreviewSettings,
  setCodePreviewSettings,
} from "../../pi-code-previews/src/config/state.ts";
import { buildCodeModeToolDefinition } from "../src/tools/controller.ts";
import { makeCodeModeToolExecute } from "../src/tools/execution.ts";
import { CodeModeResults } from "../src/results/service.ts";
import {
  callEntryDetails,
  formatForeignRejection,
  type CodeModeToolDetails,
} from "../src/tools/format.ts";
import { resultReadCompactSummary } from "../src/ui/result-read-summary.ts";
import {
  codeModeStateFixture,
  extensionContextFixture,
  opaqueHostFixture,
} from "./support/host.ts";
import { nestedToolDefinitionsFixture } from "./support/tools.ts";

const theme = opaqueHostFixture({
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
});
const definition = () =>
  buildCodeModeToolDefinition({
    catalogBudget: 0,
    includePowerShell: false,
    execute: () => Promise.reject(new Error("render-only")),
    startUiTicker: () => () => undefined,
  });

const renderer = <Args, Result>(args: Args, result: Result, isError = false) => {
  const owned = definition();
  const tool = withCodePreviewShell(owned, {
    mode: "off",
    compactSummary: owned.compactSummary,
    expandedContent: owned.expandedContent,
  });
  const state = {};
  return (expanded: boolean, width = 400) => {
    const context = opaqueHostFixture({
      args,
      state,
      expanded,
      isPartial: false,
      isError,
      executionStarted: true,
      argsComplete: true,
      invalidate() {},
    });
    const styling = theme;
    const call = tool.renderCall!(opaqueHostFixture(args), styling, context);
    const body = tool.renderResult!(
      opaqueHostFixture(result),
      { expanded, isPartial: false },
      styling,
      context,
    );
    return [...call.render(width), ...body.render(width)].join("\n");
  };
};

describe("registered expanded Code Mode views", () => {
  it("renders retained pages without execution sections, duplicated notices or internal labels", () => {
    const previous = codePreviewSettings;
    try {
      for (const style of ["compact", "preview"] as const) {
        setCodePreviewSettings({
          ...previous,
          toolCallCollapsedStyle: style,
          toolCallTiming: false,
        });
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
                expect(text.split((expanded ? issue.cause : issue.description)!).length - 1).toBe(
                  1,
                );
                for (const diagnostic of issue.diagnostics ?? [])
                  expect(text.split(diagnostic).length - 1).toBe(expanded ? 1 : 0);
              }
              for (const notice of summary.notices ?? [])
                expect(text.split(notice.text).length - 1).toBe(expanded ? 1 : 0);
            }
          }
        }
      }
    } finally {
      setCodePreviewSettings(previous);
    }
  });

  it("keeps failed, malformed and historical reads separate from execution without inventing success", () => {
    const previous = codePreviewSettings;
    try {
      setCodePreviewSettings({
        ...previous,
        toolCallCollapsedStyle: "compact",
        toolCallTiming: false,
      });
      for (const resultRead of [
        undefined,
        { status: "error", code: "revoked" },
        {
          status: "page",
          id: "other",
          originalOutcome: "succeeded",
          offset: 0,
          end: 1,
          next: null,
          total: 1,
        },
      ]) {
        const result = {
          content: [{ type: "text", text: "HISTORICAL_RECOVERY" }],
          details: { toolCalls: [], resultRead },
        };
        const text = renderer({ action: "result.read", id: "retained-1" }, result)(true);
        expect(text).toContain("HISTORICAL_RECOVERY");
        expect(text).not.toMatch(/Program|Calls|Page read succeeded/u);
      }
    } finally {
      setCodePreviewSettings(previous);
    }
  });

  it("restores read recovery when the registered result renderer cannot accept ownership", () => {
    const previous = codePreviewSettings;
    let policy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      setCodePreviewSettings({
        ...previous,
        toolCallCollapsedStyle: "compact",
        toolCallTiming: false,
      });
      const result = {
        content: [{ type: "text", text: "RAW_RECOVERY_PAGE" }],
        details: {
          toolCalls: [],
          resultRead: {
            status: "page",
            id: "retained-1",
            originalOutcome: "failed",
            offset: 0,
            end: 80,
            next: 80,
            total: 87,
          },
        },
      };
      const summary = resultReadCompactSummary(result.details, "retained-1")!;
      const render = renderer({ action: "result.read", id: "retained-1" }, result);
      policy = vi
        .spyOn(codePreviews, "captureCodePreviewPresentationPolicy")
        .mockImplementation(() => {
          throw new Error("policy capture");
        });
      const text = render(true);
      expect(text).toContain("RAW_RECOVERY_PAGE");
      for (const issue of summary.issues!.entries) {
        expect(text).toContain(issue.cause);
        for (const detail of issue.diagnostics ?? []) expect(text).toContain(detail);
      }
      for (const notice of summary.notices ?? []) expect(text).toContain(notice.text);
    } finally {
      policy?.mockRestore();
      setCodePreviewSettings(previous);
    }
  });

  it("keeps recovery merged onto a body-owned root identity", () => {
    const previous = codePreviewSettings;
    try {
      setCodePreviewSettings({
        ...previous,
        toolCallCollapsedStyle: "compact",
        toolCallTiming: false,
      });
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
    } finally {
      setCodePreviewSettings(previous);
    }
  });

  it.effect(
    "renders the actual prefixed failure body once in legacy and current expanded paths",
    () =>
      Effect.gen(function* () {
        const results = yield* CodeModeResults;
        const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
        let retained: CodeModeToolDetails | undefined;
        const state = codeModeStateFixture();
        const execute = makeCodeModeToolExecute({
          isCurrent: () => true,
          getState: () => state,
          results,
          runInSession: (effect, signal) => runPromise(effect, signal ? { signal } : undefined),
          definitions: nestedToolDefinitionsFixture({}),
          events: createEventBus(),
          sessionId: "expanded-test",
          retainFailureDetails: (_id, details) => {
            retained = details;
          },
        });
        const args = {
          code: 'throw new Error("UNCLASSIFIED_FAILURE");',
          intent: "Failure ownership",
        };
        const failure = yield* Effect.tryPromise(() =>
          execute("outer", args, undefined, undefined, extensionContextFixture({})),
        ).pipe(Effect.flip);
        expect(retained?.resultId).toBeTruthy();
        const raw = formatForeignRejection(failure.cause);
        const diagnostic = raw.split("\n").at(-1)!;
        const instruction = raw.split("\n")[0]!;
        const previous = codePreviewSettings;
        try {
          setCodePreviewSettings({
            ...previous,
            toolCallCollapsedStyle: "compact",
            toolCallTiming: false,
          });
          for (const details of [callEntryDetails([]), retained]) {
            const render = renderer(
              args,
              { content: [{ type: "text", text: raw }], details },
              true,
            );
            for (const expanded of [false, true, false, true]) {
              const text = render(expanded);
              expect(text.includes(diagnostic)).toBe(expanded);
              expect(text.split(diagnostic).length - 1).toBe(expanded ? 1 : 0);
              expect(text.split(instruction).length - 1, text).toBe(expanded ? 1 : 0);
            }
          }
        } finally {
          setCodePreviewSettings(previous);
        }
      }).pipe(Effect.provide(CodeModeResults.layer)),
  );
});
