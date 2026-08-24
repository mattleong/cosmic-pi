import type {
  AgentToolResult,
  Theme,
  ToolDefinition,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { getTextContent } from "./data/results";
import { type ToolCallBackgroundMode } from "../config/schema";
import { codePreviewSettings } from "../config/state";
import { escapeControlChars } from "../shared/terminal-text";
import { createCodePreviewToolDefinition } from "./renderer-adapter";

export interface CodePreviewShellOptions {
  /**
   * Shell mode to apply. Defaults to the code-preview setting at wrapping time.
   * The selected mode is captured; later settings reloads do not change the wrapped tool.
   */
  mode?: ToolCallBackgroundMode;

  /**
   * Leave tools that already render their own shell untouched. Defaults to true to avoid
   * double-framing or overriding custom backgrounds from cooperating extensions.
   */
  preserveSelfShell?: boolean;
}

type ToolSchema = ToolDefinition["parameters"];

/**
 * Decorate a cooperating tool definition with pi-code-previews' tool-call shell.
 *
 * This does not discover or wrap already-registered tools. The caller keeps ownership of the
 * underlying tool definition, including execute(), schemas, prompt metadata, and custom renderers.
 * Load trusted project settings before calling this function because shell mode is captured here.
 */
export function withCodePreviewShell<
  TParams extends ToolSchema,
  TDetails,
  TState,
  TTool extends ToolDefinition<TParams, TDetails, TState>,
>(
  tool: ToolDefinition<TParams, TDetails, TState> & TTool,
  options: CodePreviewShellOptions = {},
): TTool {
  const mode = options.mode ?? codePreviewSettings.toolCallBackground;
  const preserveSelfShell = options.preserveSelfShell ?? true;
  if (preserveSelfShell && tool.renderShell === "self") return tool;

  const originalRenderCall = tool.renderCall;
  const originalRenderResult = tool.renderResult;

  return createCodePreviewToolDefinition(tool, {
    mode,
    renderCall: (args, theme, context) =>
      originalRenderCall
        ? originalRenderCall(args, theme, context)
        : renderFallbackToolCall(tool, theme),
    renderResult: (result, resultOptions, theme, context) =>
      originalRenderResult
        ? originalRenderResult(result, resultOptions, theme, context)
        : renderFallbackToolResult(result, resultOptions, theme, context.isError),
  });
}

function renderFallbackToolCall(
  tool: { readonly name: string; readonly label: string },
  theme: Theme,
): Component {
  return new Text(theme.fg("toolTitle", theme.bold(tool.label || tool.name)), 0, 0);
}

function renderFallbackToolResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  isError: boolean,
): Component {
  const output = getTextContent(result.content);
  if (!output) return new Container();
  const color = isError ? "error" : options.isPartial ? "warning" : "toolOutput";
  const text = output
    .split("\n")
    .map((line) => theme.fg(color, escapeControlChars(line)))
    .join("\n");
  return new Text(text, 0, 0);
}
