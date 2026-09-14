import type { ExtensionAPI, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import {
  codePreviewSettings,
  setCodePreviewSettings,
} from "../../pi-code-previews/src/config/state.ts";
import { registerBackgroundTaskTool } from "../src/tools/background-task.ts";

it("keeps the owned log metadata header and all expanded logs without another cursor footer", () => {
  const settings = { ...codePreviewSettings };
  setCodePreviewSettings({ ...settings, toolCallCollapsedStyle: "compact", toolCallTiming: false });
  try {
    const tools: ToolDefinition[] = [];
    // SAFETY: Registration only uses registerTool on this render-only fixture.
    const pi = {
      registerTool: (tool: ToolDefinition) => {
        tools.push(tool);
      },
    } as ExtensionAPI;
    registerBackgroundTaskTool(pi, { run: () => Promise.reject(new Error("not executed")) });
    const tool = tools[0]!;
    // SAFETY: These callbacks cover the renderer's styling operations.
    const theme = {
      fg: (_key: string, text: string) => text,
      bg: (_key: string, text: string) => text,
      bold: (text: string) => text,
    } as Theme;
    const args = { action: "logs", id: "task-1" };
    const lines = Array.from({ length: 30 }, (_, index) => `log entry ${index}`);
    const result = {
      content: [
        {
          type: "text" as const,
          text: `[task-1 state=running cursor=123 earliest=45]\n${lines.join("\n")}`,
        },
      ],
      details: {
        action: "logs",
        logs: {
          id: "task-1",
          state: "running",
          nextCursor: 123,
          earliestAvailableCursor: 45,
          droppedBytes: 0,
        },
      },
    };
    const before = structuredClone(result);
    const state = {};
    for (const expanded of [true, false, true]) {
      const context = {
        args,
        state,
        cwd: "/project",
        toolCallId: "logs",
        lastComponent: undefined,
        expanded,
        executionStarted: true,
        argsComplete: true,
        isPartial: false,
        isError: false,
        showImages: false,
        invalidate: () => undefined,
      };
      const call = tool.renderCall!(args, theme, context);
      const body = tool.renderResult!(result, { expanded, isPartial: false }, theme, context);
      const text = [...call.render(120), ...body.render(120)].join("\n");
      if (expanded) {
        expect(text.match(/123/g)).toHaveLength(1);
        expect(text.match(/45/g)).toHaveLength(1);
        for (const line of lines) expect(text).toContain(line);
      }
    }
    expect(result).toEqual(before);
  } finally {
    setCodePreviewSettings(settings);
  }
});
