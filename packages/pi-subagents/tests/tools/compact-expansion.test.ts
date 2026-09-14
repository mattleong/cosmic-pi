import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import {
  codePreviewSettings,
  setCodePreviewSettings,
} from "../../../pi-code-previews/src/config/state.ts";
import { registerSubagentTools } from "../../src/tools/subagent.ts";
import { extensionApiFixture } from "../fixtures/pi-host.ts";

it("keeps the sole await heading when the live panel owns the result", () => {
  const settings = { ...codePreviewSettings };
  setCodePreviewSettings({ ...settings, toolCallCollapsedStyle: "compact", toolCallTiming: false });
  try {
    for (const panelOwns of [false, true]) {
      const tools: ToolDefinition<any, any, any>[] = [];
      registerSubagentTools(
        extensionApiFixture({
          registerTool: (tool: ToolDefinition<any, any, any>) => tools.push(tool),
        }),
        {
          environment: { cwd: "/project", projectTrusted: false },
          run: () => Promise.reject(new Error("not executed")),
          startUiTicker: () => () => undefined,
          toolPresentation: {
            beginStart: () => () => undefined,
            beginAwait: () => () => undefined,
            isLiveHierarchyAvailable: () => panelOwns,
          },
        },
      );
      const tool = tools.find((entry) => entry.name === "subagent_await")!;
      // SAFETY: These render-only callbacks cover the styling used by the tool and shell.
      const theme = {
        fg: (_key: string, text: string) => text,
        bg: (_key: string, text: string) => text,
        bold: (text: string) => text,
      } as Theme;
      const args = { runIds: ["target"], until: "all_finished" };
      const state = {};
      for (const expanded of [true, false, true]) {
        const context = {
          args,
          state,
          cwd: "/project",
          toolCallId: "await",
          lastComponent: undefined,
          expanded,
          executionStarted: true,
          argsComplete: true,
          isPartial: true,
          isError: false,
          showImages: false,
          invalidate: () => undefined,
        };
        const call = tool.renderCall!(args, theme, context);
        const result = tool.renderResult!(
          {
            content: [],
            details: { version: 2, action: "await", cards: [], awaitUntil: "all_finished" },
          },
          { expanded, isPartial: true },
          theme,
          context,
        );
        const text = [...call.render(120), ...result.render(120)].join("\n");
        if (expanded) expect(text.match(/Waiting for subagents/g)).toHaveLength(1);
      }
    }
  } finally {
    setCodePreviewSettings(settings);
  }
});
