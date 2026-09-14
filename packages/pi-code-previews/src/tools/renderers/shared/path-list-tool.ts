import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { createCodePreviewToolDefinition } from "../../renderer-adapter";
import { createBuiltinCompactSummary } from "../../builtin-compact-summary";
import { renderPathListResult, type PathListResultConfig } from "./path-list-result";

type CurrentToolDefinition = ToolDefinition<any, any, any>;
type ToolInput<Tool extends CurrentToolDefinition> = Parameters<NonNullable<Tool["renderCall"]>>[0];

type PathListToolOptions<Tool extends CurrentToolDefinition> = {
  name: "find" | "ls";
  createToolDefinition: (cwd: string) => Tool;
  renderCall: (args: ToolInput<Tool>, theme: Theme, cwd: string) => Component;
  resultConfig: (cwd: string) => PathListResultConfig;
};

export function createPathListPreviewTool<Tool extends CurrentToolDefinition>(
  cwd: string,
  options: PathListToolOptions<Tool>,
): Tool {
  const originalTool = options.createToolDefinition(cwd);
  return createCodePreviewToolDefinition(originalTool, {
    compactSummary: (input) => createBuiltinCompactSummary(options.name, input),
    renderCall: (args, theme) => options.renderCall(args, theme, cwd),
    renderResult: (result, resultOptions, theme, renderContext) =>
      renderPathListResult(result, resultOptions, theme, renderContext, options.resultConfig(cwd)),
  });
}
