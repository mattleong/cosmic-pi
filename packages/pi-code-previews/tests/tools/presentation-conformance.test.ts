import { beforeEach, expect, test } from "vitest";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth, type Component } from "@earendil-works/pi-tui";
import {
  applyPresentationSettings,
  createToolPresentationHarness,
  withPresentationSettings,
} from "../../testing";
import {
  withCodePreviewShell,
  type CodePreviewShellOptions,
} from "../../src/tools/cooperative-tools";
import type { CompactIssue } from "../../src/tools/compact-issues";
import type { CompactSummary } from "../../src/tools/compact-summary";
import { failingRenderer, stripAnsi, textResult } from "../support/render";
beforeEach(() =>
  applyPresentationSettings({ toolCallCollapsedStyle: "compact", toolCallTiming: false }),
);
const modes = ["on", "off", "border"] as const;
const result = textResult("RAW diagnostics");
const issue: CompactIssue = {
  severity: "error",
  code: "failure",
  message: "Failure cause",
  detail: "Independent recovery",
};
const count = (text: string, phrase: string) => text.split(phrase).length - 1;
const inOrder = (text: string, phrases: readonly string[]) => {
  const positions = phrases.map((phrase) => text.indexOf(phrase));
  return positions.every((position, index) => position >= (positions[index - 1] ?? 0));
};
/** The collapsed heading row of the first rendered state. */
const heading = (texts: string[]) => texts[0]!.split("\n")[0];
const textRenderer = (label: string) => () => new Text(label, 0, 0);
/** The builtin read definition with these original renderers, inside the cooperative shell. */
const readShell = (
  renderCall: () => Component,
  renderResult: () => Component,
  options: CodePreviewShellOptions,
) =>
  withCodePreviewShell(
    { ...createReadToolDefinition("/project"), renderCall, renderResult },
    options,
  );

test.each(modes)(
  "content callbacks follow the heading and issues, with every issue once, in %s mode",
  (mode) => {
    const original = {
      content: [{ type: "text" as const, text: "RAW diagnostics\nAGENT_COMMAND retry" }],
      details: undefined,
    };
    const before = JSON.stringify(original);
    const source = createReadToolDefinition("/project");
    let executions = 0;
    const tool = withCodePreviewShell(
      {
        ...source,
        execute: (...args: Parameters<typeof source.execute>) => {
          executions++;
          return source.execute(...args);
        },
        renderCall: () => new Text("ORIGINAL CALL", 0, 0),
        renderResult: () => new Text("ORIGINAL RESULT", 0, 0),
      },
      {
        mode,
        compactSummary: () => ({
          subject: "FULL_INTERNAL_SUBJECT",
          compactSubject: "Operation",
          outcome: "warning",
          issues: [
            {
              severity: "warning",
              code: "unconfirmed",
              message: "The operation may still be running",
              detail: "AGENT_DETAIL inspect status before retry",
            },
            { severity: "info", code: "page", message: "INFO_NOTE more pages" },
          ],
        }),
        expandedContent: {
          renderCall: () => new Text("CONTENT CALL", 0, 0),
          renderResult: () => new Text("CONTENT RESULT", 0, 0),
        },
      },
    );
    const h = createToolPresentationHarness(tool, { width: 120 });
    for (const { expanded, text } of h.cycle({ path: "file" }, original)) {
      expect(count(text, "The operation may still be running")).toBe(1);
      for (const phrase of ["AGENT_DETAIL", "INFO_NOTE", "CONTENT CALL", "CONTENT RESULT"])
        expect(count(text, phrase)).toBe(expanded ? 1 : 0);
      expect(text).not.toMatch(/ORIGINAL CALL|ORIGINAL RESULT|RAW diagnostics|AGENT_COMMAND/u);
      expect(text.includes("FULL_INTERNAL_SUBJECT")).toBe(expanded);
      expect(text.includes("Operation")).toBe(!expanded);
      const expandedOrder = [
        "FULL_INTERNAL_SUBJECT",
        "The operation may still be running",
        "AGENT_DETAIL",
        "INFO_NOTE",
        "CONTENT CALL",
        "CONTENT RESULT",
      ];
      expect(inOrder(text, expandedOrder)).toBe(expanded);
      expect(JSON.stringify(original)).toBe(before);
    }
    expect(executions).toBe(0);
  },
);

test.each(modes)("Pi errors reconcile with the provider's classification in %s mode", (mode) => {
  const row = (summary: CompactSummary, isError: boolean) => {
    const tool = readShell(textRenderer("ORIGINAL CALL"), textRenderer("ORIGINAL RESULT"), {
      mode,
      compactSummary: () => summary,
    });
    const h = createToolPresentationHarness(tool, { width: 120 });
    const failure = textResult("FIRST ERROR LINE\nsecond error line");
    return h
      .cycle({ path: "file" }, failure, { overrides: () => ({ isError }) })
      .map(({ text }) => text);
  };
  const success: CompactSummary = { subject: "target", outcome: "success" };
  const reconciled = row(success, true);
  for (const [index, text] of reconciled.entries()) {
    // The first line explains the error once; the rest stays with the raw error.
    expect(count(text, "FIRST ERROR LINE")).toBe(1);
    expect(text).not.toContain("second error line");
    expect(text.includes("ORIGINAL RESULT")).toBe(index % 2 === 1);
  }
  // Pi's error flag gives a claimed success the same heading as a classified error.
  expect(heading(reconciled)).toBe(heading(row({ ...success, outcome: "error" }, false)));
  expect(heading(reconciled)).not.toBe(heading(row(success, false)));

  const explained = row({ ...success, outcome: "error", issues: [issue] }, true);
  for (const text of explained) {
    expect(count(text, "Failure cause")).toBe(1);
    expect(text).not.toContain("FIRST ERROR LINE");
  }
  for (const outcome of ["cancelled", "uncertain"] as const) {
    const kept = row({ ...success, outcome }, true);
    expect(heading(kept)).toBe(heading(row({ ...success, outcome }, false)));
    for (const text of kept) expect(text).not.toContain("FIRST ERROR LINE");
  }
});

test("issue text wraps without clipping at narrow widths in every frame", () => {
  const message = "日本語 cleanup-is-unconfirmed for the remote operation";
  const detail = "Inspect 文字 state before retrying the operation";
  for (const mode of modes) {
    const tool = readShell(textRenderer("call"), textRenderer("result"), {
      mode,
      compactSummary: () => ({
        subject: "src/" + "nested/".repeat(10) + "file.ts",
        outcome: "warning",
        issues: [{ severity: "warning", code: "cleanup", message, detail }],
      }),
    });
    const h = createToolPresentationHarness(tool);
    for (const expanded of [false, true]) {
      h.call({ path: "file" }, { expanded });
      h.result(result, { expanded });
      // Includes the narrowest widths, where the border frame must yield entirely.
      for (const width of [2, 4, 5, 8, 12, 20, 40]) {
        const rows = h.render(width);
        expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
        if (mode !== "off") continue;
        const text = stripAnsi(rows.join("")).replace(/\s/gu, "");
        expect(text).toContain(message.replace(/\s/gu, ""));
        expect(text.includes(detail.replace(/\s/gu, ""))).toBe(expanded);
      }
    }
  }
});

test.each(modes)("parent timing has one owner across expansion and fallback in %s mode", (mode) => {
  for (const path of [
    "content",
    "error",
    "original",
    "original-error",
    "factory",
    "draw",
  ] as const) {
    const failure = path === "error" || path === "original-error";
    const summary: CompactSummary = {
      subject: "target",
      outcome: failure ? "error" : "success",
      showTiming: true,
      ...(failure && { issues: [issue] }),
    };
    const tool = readShell(textRenderer("arguments"), textRenderer("output"), {
      mode,
      compactSummary: () => summary,
      ...(!path.startsWith("original") && {
        expandedContent: {
          renderCall: textRenderer("complete arguments"),
          renderResult: failingRenderer(path, ["complete output"]),
        },
      }),
    });
    for (const timing of [true, false]) {
      withPresentationSettings({ toolCallTiming: timing }, () => {
        const h = createToolPresentationHarness(tool, {
          state: { codePreviewTimingStartedAt: 1000, codePreviewTimingEndedAt: 3379 },
        });
        for (const expanded of [false, true, false, true]) {
          h.call({ path: "file" }, { expanded, isPartial: false });
          h.result(result, { expanded, isError: failure });
          const occurrences = (width: number) =>
            h.render(width).join("\n").match(/2\.4s/g)?.length ?? 0;
          expect(occurrences(120), `${path}, timing=${timing}, expanded=${expanded}`).toBe(
            timing ? 1 : 0,
          );
          expect(occurrences(12)).toBeLessThanOrEqual(timing ? 1 : 0);
        }
      });
    }
  }
});

test("quick non-native calls keep the default threshold even when timing placement is requested", () => {
  for (const style of ["compact", "preview"] as const)
    for (const mode of ["off", "on", "border"] as const)
      withPresentationSettings({ toolCallTiming: true, toolCallCollapsedStyle: style }, () => {
        const tool = withCodePreviewShell(
          {
            ...createReadToolDefinition("/project"),
            name: "bash",
            renderCall: () => new Text("arguments", 0, 0),
            renderResult: () => new Text("output", 0, 0),
          },
          {
            mode,
            compactSummary: () => ({ subject: "file", outcome: "success", showTiming: true }),
          },
        );
        const h = createToolPresentationHarness(tool, {
          state: { codePreviewTimingStartedAt: 1000, codePreviewTimingEndedAt: 1379 },
        });
        h.call({ path: "file" }, { isPartial: false });
        h.result(textResult("output"));
        expect(stripAnsi(h.render(120).join("\n")), `${style} ${mode}`).not.toContain("379ms");
      });
});

test("partial content hooks retain the other slot and malformed-to-valid switches keep slot caches separate", () => {
  for (const slot of ["call", "result"] as const) {
    let valid = true;
    const seen: Array<Component | undefined> = [];
    const content = new Text("NEW CONTENT", 0, 0);
    const oldCall = new Text("ORIGINAL CALL", 0, 0);
    const oldResult = new Text("ORIGINAL RESULT", 0, 0);
    const tool = readShell(
      () => oldCall,
      () => oldResult,
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

test("content construction or drawing failure falls back in that slot and keeps issues once", () => {
  for (const failure of ["none", "factory", "draw"] as const) {
    const tool = readShell(textRenderer("ORIGINAL CALL"), textRenderer("ORIGINAL RESULT"), {
      mode: "off",
      compactSummary: () => ({
        subject: "read result",
        outcome: "error",
        issues: [issue, { severity: "info", code: "page", message: "Continue with next page" }],
      }),
      expandedContent: {
        renderCall: textRenderer("unique call"),
        renderResult: failingRenderer(failure, ["content output"]),
      },
    });
    const h = createToolPresentationHarness(tool);
    h.call({ path: "file" }, { expanded: true });
    h.result(result, { expanded: true });
    for (let redraw = 0; redraw < 2; redraw++) {
      const text = h.render().join("\n");
      expect(text).toContain("unique call");
      for (const phrase of ["Failure cause", "Independent recovery", "Continue with next page"])
        expect(count(text, phrase)).toBe(1);
      expect(text).not.toMatch(/ORIGINAL/u);
      expect(text.includes("content output")).toBe(failure === "none");
      expect(text.includes("RAW diagnostics")).toBe(failure !== "none");
    }
  }
});

test.each(modes)("drawing failures fall back only in the failed slot in %s mode", (mode) => {
  for (const failedSlot of ["call", "result"] as const) {
    let hostileDraws = 0;
    let callConstructions = 0;
    let resultConstructions = 0;
    const slot = (name: "call" | "result", line: string) => (): Component => {
      if (name === "call") callConstructions++;
      else resultConstructions++;
      return {
        render: () => {
          if (failedSlot !== name) return [line];
          hostileDraws++;
          throw new Error(`${name} draw failed`);
        },
        invalidate() {},
      };
    };
    const tool = readShell(
      slot("call", "unique original call"),
      slot("result", "unique original result"),
      {
        mode,
        compactSummary: () => ({ subject: "file", outcome: "error", issues: [issue] }),
      },
    );
    const h = createToolPresentationHarness(tool);
    h.call({ path: "file" }, { expanded: true });
    h.result(result, { expanded: true });
    const healthy = failedSlot === "result" ? "unique original call" : "unique original result";
    for (let redraw = 0; redraw < 2; redraw++) {
      const text = h.render().join("\n");
      expect(text).toContain(healthy);
      expect(count(text, "Failure cause")).toBe(1);
      expect(count(text, "Independent recovery")).toBe(1);
      expect(text.includes("RAW diagnostics")).toBe(failedSlot === "result");
    }
    expect(hostileDraws).toBe(1);
    expect(callConstructions).toBe(1);
    expect(resultConstructions).toBe(1);
    h.invalidate();
    const refreshed = h.render(100).join("\n");
    expect(refreshed).toContain(healthy);
    expect(count(refreshed, "Failure cause")).toBe(1);
    expect(hostileDraws).toBe(1);
  }
});

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
              return ["Recovered output"];
            },
            invalidate() {},
          };
        };
        const tool = readShell(textRenderer("Unique arguments"), renderResult, {
          mode: "off",
          compactSummary: () => ({ subject: "file", outcome: "error", issues: [issue] }),
          ...(contentOnly && { expandedContent: { renderResult } }),
        });
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
          expect(count(text, "Failure cause")).toBe(1);
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
        expect(count(text, "Failure cause")).toBe(1);
        expect(attempts).toBe(2);
      }
    }
  },
);
