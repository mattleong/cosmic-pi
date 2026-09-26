import { beforeEach, expect, test } from "vitest";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import {
  applyPresentationSettings,
  createToolPresentationHarness,
  withPresentationSettings,
} from "../../testing";
import { withCodePreviewShell } from "../../src/tools/cooperative-tools";
import { claimCompactIssue, type CompactIssue } from "../../src/tools/compact-issues";
import type { CompactSummary } from "../../src/tools/compact-summary";
import { failingRenderer, textResult } from "../support/render";
beforeEach(() =>
  applyPresentationSettings({ toolCallCollapsedStyle: "compact", toolCallTiming: false }),
);
const result = textResult("RAW diagnostics");
const issue: CompactIssue = {
  operation: "original-execution",
  code: "failure",
  severity: "error",
  cause: "Failure cause",
  description: "Failure cause",
  recovery: [{ code: "inspect", text: "Independent recovery" }],
};

test.each(["on", "off", "border"] as const)(
  "compact descriptions do not expose or erase agent evidence in %s mode",
  (mode) => {
    const human = "The operation may still be running.";
    const cause = "CANONICAL_CAUSE with provider internals";
    const recovery = "AGENT_COMMAND inspect status before retry";
    const diagnostic = "ORIGINAL_DIAGNOSTIC";
    const original = {
      content: [{ type: "text" as const, text: `${cause}\n${recovery}\n${diagnostic}` }],
      details: undefined,
    };
    const before = JSON.stringify(original);
    const source = createReadToolDefinition("/project");
    const tool = withCodePreviewShell(
      {
        ...source,
        renderCall: () => new Text("complete input", 0, 0),
        renderResult: () => new Text(original.content[0]!.text, 0, 0),
      },
      {
        mode,
        compactSummary: () => ({
          subject: "OPAQUE_INTERNAL_ID",
          compactSubject: "Operation",
          outcome: "uncertain",
          issues: {
            coverage: "unknown",
            entries: [
              {
                operation: "INTERNAL_OPERATION_ID",
                code: "unknown",
                severity: "warning",
                cause,
                description: human,
                recovery: [{ code: "inspect", text: recovery }],
                diagnostics: [diagnostic],
              },
            ],
          },
        }),
      },
    );
    const h = createToolPresentationHarness(tool, { width: 120 });
    for (const { expanded, text } of h.cycle({ path: "file" }, original)) {
      expect(text.includes(human)).toBe(!expanded);
      for (const evidence of [cause, recovery, diagnostic])
        expect(text.includes(evidence)).toBe(expanded);
      expect(!expanded && /OPAQUE_INTERNAL_ID|INTERNAL_OPERATION_ID/.test(text)).toBe(false);
      expect(JSON.stringify(original)).toBe(before);
    }
    expect(tool.execute).toBe(source.execute);
  },
);

test.each(["on", "off", "border"] as const)(
  "parent timing has one owner across expansion and fallback in %s mode",
  (mode) => {
    for (const path of [
      "content",
      "failure",
      "legacy",
      "legacy-failure",
      "factory",
      "draw",
    ] as const) {
      const failure = path === "failure" || path === "legacy-failure";
      const summary: CompactSummary = {
        subject: "target",
        outcome: failure ? "error" : "success",
        showTiming: true,
        ...(failure && { failure: { cause: "cause", details: "full diagnostic" } }),
      };
      const tool = withCodePreviewShell(
        {
          ...createReadToolDefinition("/project"),
          renderCall: () => new Text("arguments", 0, 0),
          renderResult: () => new Text("output", 0, 0),
        },
        {
          mode,
          compactSummary: () => summary,
          ...(!path.startsWith("legacy") && {
            expandedContent: {
              renderCall: () => new Text("complete arguments", 0, 0),
              renderResult: failingRenderer(path, ["complete output"]),
            },
          }),
        },
      );
      for (const timing of [true, false]) {
        withPresentationSettings({ toolCallTiming: timing }, () => {
          const h = createToolPresentationHarness(tool, {
            state: { codePreviewTimingStartedAt: 1000, codePreviewTimingEndedAt: 1379 },
          });
          for (const expanded of [false, true, false, true]) {
            h.call({ path: "file" }, { expanded, isPartial: false });
            h.result(result, { expanded, isError: failure });
            const occurrences = (width: number) =>
              h.render(width).join("\n").match(/379ms/g)?.length ?? 0;
            expect(occurrences(120), `${path}, timing=${timing}, expanded=${expanded}`).toBe(
              timing ? 1 : 0,
            );
            expect(occurrences(12)).toBeLessThanOrEqual(timing ? 1 : 0);
          }
        });
      }
    }
  },
);

test("expanded failure retains unique multiline call content and one claimed diagnostic body", () => {
  for (const mode of ["on", "off", "border"] as const) {
    const source = createReadToolDefinition("/project");
    const tool = withCodePreviewShell(
      {
        ...source,
        renderCall: () => new Text("OLD CALL", 0, 0),
        renderResult: () => new Text("OLD RESULT", 0, 0),
      },
      {
        mode,
        compactSummary: () => ({
          subject: "short target",
          outcome: "error",
          issues: { coverage: "complete", entries: [issue] },
          failure: {
            cause: issue.cause,
            details: "Failure cause\nFull diagnostic",
            ownedIssues: [claimCompactIssue(issue, { cause: true })],
          },
        }),
        expandedContent: {
          renderCall: () => new Text("Full source line one\nUnique source line two", 0, 0),
          renderResult: () => new Text("UNUSED RESULT", 0, 0),
        },
      },
    );
    expect(tool.execute).toBe(source.execute);
    const h = createToolPresentationHarness(tool);
    for (const expanded of [false, true, false, true]) {
      h.call({ path: "file" }, { expanded });
      h.result(result, { expanded, isError: true });
      for (const width of [35, 100]) {
        const text = h.render(width).join("\n");
        expect(text.includes("Unique source line two")).toBe(expanded);
        expect(text.match(/Failure cause/g)).toHaveLength(1);
        expect(text.includes("Independent recovery")).toBe(expanded);
        expect(text).not.toMatch(/OLD CALL|OLD RESULT|UNUSED RESULT/);
      }
    }
  }
});

test("failure body cannot borrow claims from an unrendered original result", () => {
  const tool = withCodePreviewShell(
    {
      ...createReadToolDefinition("/project"),
      renderCall: () => new Text("Original unique arguments", 0, 0),
    },
    {
      mode: "off",
      compactSummary: () => ({
        subject: "target",
        outcome: "error",
        issues: { coverage: "complete", entries: [issue] },
        failure: { cause: "Other failure", details: "Other full diagnostic" },
        expandedResultOwnsIssues: [
          claimCompactIssue(issue, { cause: true, recovery: ["inspect"] }),
        ],
      }),
      expandedContent: { renderResult: () => new Text("Must not render", 0, 0) },
    },
  );
  const h = createToolPresentationHarness(tool);
  h.call({ path: "file" }, { expanded: true });
  h.result(result, { expanded: true });
  const text = h.render().join("\n");
  expect(text).toContain("Original unique arguments");
  expect(text).toContain("Failure cause");
  expect(text).toContain("Independent recovery");
  expect(text).not.toContain("Must not render");
});

test("partial content hooks retain the other slot and malformed-to-valid switches keep slot caches separate", () => {
  for (const slot of ["call", "result"] as const) {
    let valid = true;
    const seen: Array<Component | undefined> = [];
    const content = new Text("NEW CONTENT", 0, 0);
    const oldCall = new Text("ORIGINAL CALL", 0, 0);
    const oldResult = new Text("ORIGINAL RESULT", 0, 0);
    const tool = withCodePreviewShell(
      {
        ...createReadToolDefinition("/project"),
        renderCall: () => oldCall,
        renderResult: () => oldResult,
      },
      {
        mode: "off",
        compactSummary: () => (valid ? { subject: "target", outcome: "success" } : undefined),
        expandedContent:
          slot === "call"
            ? {
                renderCall: (_args, _theme, ctx) => {
                  seen.push(ctx.lastComponent);
                  return content;
                },
              }
            : {
                renderResult: (_result, _options, _theme, ctx) => {
                  seen.push(ctx.lastComponent);
                  return content;
                },
              },
      },
    );
    const h = createToolPresentationHarness(tool);
    for (valid of [true, false, true]) {
      h.call({ path: "file" }, { expanded: true });
      h.result(result, { expanded: true });
      const text = h.render().join("\n");
      expect(text).toContain(slot === "call" ? "ORIGINAL RESULT" : "ORIGINAL CALL");
      expect(text.includes("NEW CONTENT")).toBe(valid);
    }
    expect(seen).toEqual([undefined, content]);
  }
});

test("unknown coverage uses content rendering and revokes claims on construction or drawing failure", () => {
  for (const failure of ["none", "factory", "draw"] as const) {
    const summary: CompactSummary = {
      subject: "read result",
      outcome: "error",
      issues: {
        coverage: "unknown",
        entries: [
          issue,
          {
            operation: "outer-information",
            code: "page",
            severity: "warning",
            cause: "Continue with next page",
            recovery: [],
          },
        ],
      },
      expandedResultOwnsIssues: [claimCompactIssue(issue, { cause: true })],
    };
    const tool = withCodePreviewShell(
      {
        ...createReadToolDefinition("/project"),
        renderCall: () => new Text("LEGACY CALL", 0, 0),
        renderResult: () => new Text("LEGACY RESULT", 0, 0),
      },
      {
        mode: "off",
        compactSummary: () => summary,
        expandedContent: {
          renderCall: () => new Text("unique call", 0, 0),
          renderResult: failingRenderer(failure, ["Failure cause"]),
        },
      },
    );
    const h = createToolPresentationHarness(tool);
    h.call({ path: "file" }, { expanded: true });
    h.result(result, { expanded: true });
    const text = h.render().join("\n");
    expect(text).toContain("unique call");
    expect(text.match(/Failure cause/g)).toHaveLength(1);
    expect(text.match(/Continue with next page/g)).toHaveLength(1);
    expect(text).toContain("Independent recovery");
    expect(text).not.toMatch(/original-execution:|outer-information:|LEGACY/);
    expect(text.includes("RAW diagnostics")).toBe(failure !== "none");
  }
});

test.each(["on", "off", "border"] as const)(
  "drawing failures revoke only the failed slot's ownership in %s mode",
  (mode) => {
    for (const failedSlot of ["call", "result"] as const) {
      let hostileDraws = 0;
      let callConstructions = 0;
      let resultConstructions = 0;
      const tool = withCodePreviewShell(
        {
          ...createReadToolDefinition("/project"),
          renderCall: () => {
            callConstructions++;
            return {
              render: () => {
                if (failedSlot === "call") {
                  hostileDraws++;
                  throw new Error("call draw failed");
                }
                return ["unique original call"];
              },
              invalidate() {},
            };
          },
          renderResult: () => {
            resultConstructions++;
            return {
              render: () => {
                if (failedSlot === "result") {
                  hostileDraws++;
                  throw new Error("result draw failed");
                }
                return ["unique original result", "Failure cause"];
              },
              invalidate() {},
            };
          },
        },
        {
          mode,
          compactSummary: () => ({
            subject: "file",
            outcome: "error",
            issues: { coverage: "complete", entries: [issue] },
            // Failed results must release the healthy call they initially suppressed.
            ...(failedSlot === "result" && { expandedResultOwnsCall: true as const }),
            expandedResultOwnsIssues: [claimCompactIssue(issue, { cause: true })],
          }),
        },
      );
      const h = createToolPresentationHarness(tool);
      h.call({ path: "file" }, { expanded: true });
      h.result(result, { expanded: true });
      for (let redraw = 0; redraw < 2; redraw++) {
        const text = h.render().join("\n");
        expect(text).toContain(
          failedSlot === "result" ? "unique original call" : "unique original result",
        );
        expect(text.match(/Failure cause/g)).toHaveLength(1);
        expect(text).toContain("Independent recovery");
        expect(text.includes("RAW diagnostics")).toBe(failedSlot === "result");
      }
      expect(hostileDraws).toBe(1);
      expect(callConstructions).toBe(1);
      expect(resultConstructions).toBe(1);
      h.invalidate();
      const refreshed = h.render(100).join("\n");
      expect(refreshed).toContain(
        failedSlot === "result" ? "unique original call" : "unique original result",
      );
      expect(refreshed.match(/Failure cause/g)).toHaveLength(1);
      expect(hostileDraws).toBe(1);
    }
  },
);

test.each(["factory", "draw"] as const)(
  "%s failures survive host invalidation and recover only on changed inputs",
  (failure) => {
    for (const contentOnly of [false, true]) {
      for (const change of ["args", "content", "details", "lifecycle"] as const) {
        let broken = true;
        let attempts = 0;
        const renderResult = () => {
          if (failure === "factory") {
            attempts++;
            if (broken) throw new Error("factory failed");
          }
          return {
            render() {
              if (failure === "draw") {
                attempts++;
                if (broken) throw new Error("draw failed");
              }
              return ["Recovered output", "Failure cause"];
            },
            invalidate() {},
          };
        };
        const tool = withCodePreviewShell(
          {
            ...createReadToolDefinition("/project"),
            renderCall: () => new Text("Unique arguments", 0, 0),
            renderResult,
          },
          {
            mode: "off",
            compactSummary: () => ({
              subject: "file",
              outcome: "error",
              issues: { coverage: "complete", entries: [issue] },
              expandedResultOwnsIssues: [claimCompactIssue(issue, { cause: true })],
            }),
            ...(contentOnly && { expandedContent: { renderResult } }),
          },
        );
        const h = createToolPresentationHarness(tool);
        const args = { path: "file" };
        h.call(args, { expanded: true });
        h.result(result, { expanded: true });
        expect(h.render().join("\n")).toContain("RAW diagnostics");
        broken = false;
        for (const expanded of [true, false, true]) {
          // A fresh result envelope is not new host evidence.
          h.call(args, { expanded });
          h.result({ ...result }, { expanded });
          h.invalidate();
          h.context.invalidate();
          const text = h.render(100).join("\n");
          expect(text).not.toContain("Recovered output");
          expect(text.includes("Unique arguments")).toBe(expanded);
          expect(text.includes("RAW diagnostics")).toBe(expanded);
          expect(text.match(/Failure cause/g)).toHaveLength(1);
          expect(text.includes("Independent recovery")).toBe(expanded);
          expect(attempts).toBe(1);
        }
        if (change === "args") h.call({ path: "changed" });
        if (change === "content") h.result({ ...result, content: [...result.content] });
        if (change === "details") h.result({ ...result, details: { repaired: true } });
        if (change === "lifecycle") h.result(result, { isPartial: true });
        const text = h.render().join("\n");
        expect(text).toContain("Recovered output");
        expect(text).toContain("Unique arguments");
        expect(text).not.toContain("RAW diagnostics");
        expect(text.match(/Failure cause/g)).toHaveLength(1);
        expect(attempts).toBe(2);
      }
    }
  },
);
