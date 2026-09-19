import type { Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it } from "vitest";
import { createToolPresentationHarness } from "pi-code-previews/testing";
import {
  codePreviewSettings,
  setCodePreviewSettings,
} from "../../../pi-code-previews/src/config/state.ts";
import { buildMcpTool, wrapMcpTool } from "../../src/tools/controller.ts";
import { makeMcpErrorReceipts } from "../../src/boundary/host-tool-result.ts";
import { projectMcpCompactSummary } from "../../src/ui/compact-summary.ts";

const settings = { ...codePreviewSettings };
afterEach(() => setCodePreviewSettings(settings));
// SAFETY: These are all styling operations used by the registered tool.
const theme = {
  fg: (_key: string, text: string) => text,
  bg: (_key: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;
const registered = (mode: "on" | "off" | "border", style: "compact" | "preview" = "compact") => {
  setCodePreviewSettings({
    ...settings,
    toolCallBackground: mode,
    toolCallCollapsedStyle: style,
    toolCallTiming: false,
  });
  return wrapMcpTool(
    buildMcpTool({
      owner: Symbol("presentation"),
      receipts: makeMcpErrorReceipts(),
      execute: () => Promise.reject(new Error("Rendering must not execute")),
    }),
  );
};

it("renders unknown-coverage boundary attention once through the real MCP factory", () => {
  for (const mode of ["on", "off", "border"] as const) {
    for (const failure of [
      { kind: "stale", outcome: "not-sent" },
      { kind: "cleanup", outcome: "unknown" },
      { kind: "auth-required", reason: "oauth-mutation-unresolved", outcome: "unknown" },
    ]) {
      const args = { action: "result.read", id: "retained-1" };
      const result = {
        content: [],
        details: {
          action: args.action,
          outcome: failure.outcome,
          isError: true,
          notices: ["Independent operator recovery"],
          data: { ...failure, message: "Original raw diagnostic" },
        },
      };
      const before = structuredClone(result);
      const summary = projectMcpCompactSummary({ phase: "settled", args, result, isError: true })!;
      expect(summary.issues?.coverage).toBe("unknown");
      const harness = createToolPresentationHarness(registered(mode), { theme });
      for (const expanded of [false, true, false, true]) {
        harness.call(args, { expanded, isPartial: false, isError: true });
        harness.result(result, { expanded, isError: true });
        harness.invalidate();
        const text = harness.render(400).join("\n");
        expect(text.includes("Original raw diagnostic")).toBe(expanded);
        for (const issue of summary.issues!.entries) {
          const visible = expanded ? issue.cause : issue.description;
          if (visible) expect(text.split(visible).length - 1).toBe(1);
          for (const recovery of issue.recovery)
            expect(text.split(recovery.text).length - 1).toBe(expanded ? 1 : 0);
          for (const detail of issue.diagnostics ?? [])
            expect(text.split(detail).length - 1).toBe(expanded ? 1 : 0);
        }
      }
      expect(result).toEqual(before);
    }
  }
});

it("preserves retained read delivery and original outcome separately", () => {
  const args = { action: "result.read", id: "retained-1" };
  const result = {
    content: [],
    details: {
      action: "result.read",
      outcome: "completed",
      isError: false,
      notices: [],
      data: {
        offset: 0,
        next: null,
        total: 12,
        text: "retained raw",
        origin: { action: "tools.call", outcome: "unknown", isError: false },
      },
    },
  };
  const summary = projectMcpCompactSummary({ phase: "settled", args, result, isError: false });
  expect(summary?.outcome).toBe("warning");
  expect(summary?.counters?.[0]).toContain("0..12/12");
  expect(summary?.issues?.entries.some((issue) => issue.code === "execution-unknown")).toBe(true);
  const harness = createToolPresentationHarness(registered("border"), { theme });
  harness.call(args, { expanded: true, isPartial: false });
  harness.result(result);
  const text = harness.render(200).join("\n");
  expect(text).toContain("retained raw");
  expect(text).toContain("do not replay");
});

it("retains unclassified and display-cut recovery through fallback cards", () => {
  for (const mode of ["on", "off", "border"] as const) {
    for (const style of ["compact", "preview"] as const) {
      for (const details of [
        undefined,
        { malformed: true },
        {
          action: "tools.call",
          outcome: "unknown",
          isError: true,
          notices: ["Unclassified recovery instruction"],
          data: {
            kind: "unknown-kind",
            message: "Original recovery diagnostic",
            result: "large-output ".repeat(6000),
          },
        },
      ]) {
        const args = { action: "tools.call", server: "server", tool: "tool" };
        const result = { content: [{ type: "text" as const, text: "Historical output" }], details };
        const harness = createToolPresentationHarness(registered(mode, style), { theme });
        for (const expanded of [false, true, false]) {
          harness.call(args, { expanded, isPartial: false, isError: true });
          harness.result(result, { expanded, isError: true });
          const text = harness.render(200).join("\n");
          if (expanded && details && "action" in details)
            expect(text).toContain("Unclassified recovery instruction");
          expect(result.content[0]?.text).toBe("Historical output");
        }
      }
    }
  }
});
