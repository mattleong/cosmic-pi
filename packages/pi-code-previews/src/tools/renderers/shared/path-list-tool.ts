import type { ExtensionAPI, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { createCodePreviewToolShell } from "../../../preview/tool-shell";
import { renderPathListResult, type PathListResultConfig } from "./path-list-result";

type CurrentToolDefinition = ToolDefinition<any, any, any>;
type ToolInput<Tool extends CurrentToolDefinition> = Parameters<NonNullable<Tool["renderCall"]>>[0];

type PathListToolOptions<Tool extends CurrentToolDefinition> = {
  createToolDefinition: (cwd: string) => Tool;
  renderCall: (args: ToolInput<Tool>, theme: Theme, cwd: string) => Component;
  resultConfig: (cwd: string) => PathListResultConfig;
};

export function registerPathListTool<Tool extends CurrentToolDefinition>(
  pi: ExtensionAPI,
  cwd: string,
  options: PathListToolOptions<Tool>,
): void {
  const originalTool = options.createToolDefinition(cwd);
  const previewShell = createCodePreviewToolShell();
  pi.registerTool({
    ...originalTool,
    renderShell: previewShell.renderShell,
    renderCall(args, theme, context) {
      return previewShell.renderCall(context, theme, () => options.renderCall(args, theme, cwd));
    },
    renderResult(result, resultOptions, theme, context) {
      return previewShell.renderResult(context, theme, (renderContext) =>
        renderPathListResult(
          result,
          resultOptions,
          theme,
          renderContext,
          options.resultConfig(cwd),
        ),
      );
    },
  });
}
