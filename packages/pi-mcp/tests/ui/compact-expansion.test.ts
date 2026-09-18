import type { Theme } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { createCompactToolShell } from "../../../pi-code-previews/src/preview/compact-shell.ts";
import { mcpCompactSummary } from "../../src/ui/compact-summary.ts";
import { renderMcpCall, renderMcpResult } from "../../src/ui/tool-renderer.ts";
import { decodeMcpCardDetails } from "../../src/ui/tool-render-details.ts";
import { Text } from "@earendil-works/pi-tui";

it("rejected retained reads and missing details never force a full collapsed card", () => {
  // SAFETY: The fixture supplies all styling methods used by the shell.
  const theme = {
    fg: (_key: string, text: string) => text,
    bg: (_key: string, text: string) => text,
    bold: (text: string) => text,
  } as Theme;
  for (const isError of [false, true]) {
    for (const details of [
      undefined,
      {
        action: "result.read",
        outcome: "not-sent",
        isError: true,
        notices: [],
        data: {
          kind: "invalid-input",
          message: "result.read requires id, not server.",
          reason: "gateway-request-invalid",
        },
      },
    ]) {
      const shell = createCompactToolShell("border", {
        name: "mcp",
        compactSummary: mcpCompactSummary,
      });
      const args = { action: "result.read", server: "wrong-field" };
      const state = {};
      const result = {
        content: [{ type: "text" as const, text: "Complete recovery diagnostic" }],
        details,
      };
      for (const expanded of [false, true, false]) {
        const context = {
          args,
          state,
          cwd: "/project",
          toolCallId: "rejected-read",
          lastComponent: undefined,
          expanded,
          executionStarted: false,
          argsComplete: true,
          isPartial: false,
          isError,
          showImages: false,
          invalidate: () => undefined,
        };
        const call = shell.renderCall(context, theme, () => new Text("Original call body", 0, 0));
        const body = shell.renderResult(
          context,
          theme,
          () => new Text("Complete recovery diagnostic", 0, 0),
          result,
        );
        const text = [...call.render(200), ...body.render(200)].join("\n");
        expect(text.includes("Original call body")).toBe(expanded);
        expect(text.includes("Complete recovery diagnostic")).toBe(expanded);
        expect(text.includes("result.read")).toBe(!expanded);
      }
    }
  }
});

it("shares known MCP notices and recovery with the expanded result, retaining discovery guidance", () => {
  // SAFETY: This render-only theme supplies the shell and MCP card styling callbacks.
  const theme = {
    fg: (_key: string, text: string) => text,
    bg: (_key: string, text: string) => text,
    bold: (text: string) => text,
  } as Theme;
  const result = {
    content: [],
    details: {
      action: "tools.list",
      outcome: "completed",
      isError: false,
      notices: ["Operator notice"],
      resultId: "retained-1",
      data: { truncated: true, result: { undiscovered: ["other"] } },
    },
  };
  const before = structuredClone(result);
  const card = decodeMcpCardDetails(result);
  for (const mode of ["on", "off", "border"] as const) {
    const shell = createCompactToolShell(mode, { name: "mcp", compactSummary: mcpCompactSummary });
    const state = {};
    for (const expanded of [true, false, true]) {
      const args = { action: "tools.list", server: "catalog" };
      const context = {
        args,
        state,
        cwd: "/project",
        toolCallId: "mcp",
        lastComponent: undefined,
        expanded,
        executionStarted: true,
        argsComplete: true,
        isPartial: false,
        isError: false,
        showImages: false,
        invalidate: () => undefined,
      };
      const call = shell.renderCall(context, theme, () => renderMcpCall(args, theme));
      const body = shell.renderResult(
        context,
        theme,
        () => renderMcpResult(result, { expanded, isPartial: false }, theme, "expand"),
        result,
      );
      const text = [...call.render(200), ...body.render(200)].join("\n");
      if (expanded) {
        for (const notice of [...card.warnings, ...card.notices]) expect(text).toContain(notice);
        expect(text).toContain(card.recoveryHint);
        expect(text).toContain("Discovery is incomplete");
      } else {
        for (const issue of card.presentation.issues.entries) {
          expect(text).toContain(issue.cause);
          for (const recovery of issue.recovery) expect(text).toContain(recovery.text);
        }
      }
      // Actual output loss keeps access instructions visible, unlike routine retained IDs.
      expect(text).toContain(card.resultId);
    }
  }
  expect(result).toEqual(before);
});
