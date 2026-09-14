import type { Theme } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { createCompactToolShell } from "../../../pi-code-previews/src/preview/compact-shell.ts";
import { mcpCompactSummary } from "../../src/ui/compact-summary.ts";
import { renderMcpCall, renderMcpResult } from "../../src/ui/tool-renderer.ts";
import { decodeMcpCardDetails } from "../../src/ui/tool-render-details.ts";

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
      for (const notice of [...card.warnings, ...card.notices, card.recoveryHint!]) {
        expect(text.split(notice)).toHaveLength(2);
      }
      expect(text).toContain("Discovery is incomplete.");
    }
  }
  expect(result).toEqual(before);
});
