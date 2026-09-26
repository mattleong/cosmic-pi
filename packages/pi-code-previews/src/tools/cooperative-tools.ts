import type {
  AgentToolResult,
  Theme,
  ToolDefinition,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { getFallbackResultText } from "./data/results";
import { type ToolCallBackgroundMode } from "../config/schema";
import { codePreviewSettings } from "../config/state";
import { escapeControlChars } from "../shared/terminal-text";
import { createCodePreviewToolDefinition, type CodePreviewToolRenderers } from "./renderer-adapter";
import type { CompactAnimationScheduler, CompactSummaryProvider } from "./compact-summary";
import type { ToolRenderContext } from "./renderers/shared/types";

export interface CodePreviewShellOptions<TArgs = unknown, TDetails = unknown, TState = unknown> {
  /**
   * Shell mode to apply. Defaults to the code-preview setting at wrapping time.
   * The selected mode is captured; later settings reloads do not change the wrapped tool.
   */
  mode?: ToolCallBackgroundMode;

  /**
   * Leave self-shell tools untouched in preview mode. Defaults to true.
   * Compact mode always wraps owned tools; expansion restores their original components.
   */
  preserveSelfShell?: boolean;

  /** Supply semantic compact details. Declining uses a generic row with details on expansion. */
  compactSummary?: CompactSummaryProvider<TArgs, TDetails, TState>;

  /** Unique expanded content only: no heading or shared attention container. */
  expandedContent?: {
    renderCall?: (
      args: Partial<TArgs>,
      theme: Theme,
      context: ToolRenderContext<TState, Partial<TArgs>>,
    ) => Component;
    renderResult?: (
      result: AgentToolResult<TDetails>,
      options: ToolRenderResultOptions,
      theme: Theme,
      context: ToolRenderContext<TState, Partial<TArgs>>,
    ) => Component;
  };

  /** Session-owned scheduler. Independent extension loaders cannot share previews' runtime. */
  scheduleAnimation?: CompactAnimationScheduler | undefined;
}

/**
 * Decorate a cooperating tool definition with pi-code-previews' tool-call shell.
 *
 * This does not discover or wrap already-registered tools. The caller keeps ownership of the
 * underlying tool definition, including execute(), schemas, prompt metadata, and custom renderers.
 * Load trusted project settings before calling this function because shell mode is captured here.
 */
export function withCodePreviewShell<
  TParams extends ToolDefinition["parameters"],
  TDetails,
  TState,
  TTool extends ToolDefinition<TParams, TDetails, TState>,
>(
  tool: ToolDefinition<TParams, TDetails, TState> & TTool,
  options: CodePreviewShellOptions<
    Parameters<TTool["execute"]>[1],
    Awaited<ReturnType<TTool["execute"]>> extends AgentToolResult<infer TResultDetails>
      ? TResultDetails
      : unknown,
    Parameters<NonNullable<TTool["renderCall"]>>[2]["state"]
  > = {},
): TTool {
  const mode = options.mode ?? codePreviewSettings.toolCallBackground;
  const preserveSelfShell = options.preserveSelfShell ?? true;
  if (
    preserveSelfShell &&
    tool.renderShell === "self" &&
    codePreviewSettings.toolCallCollapsedStyle !== "compact"
  )
    return tool;

  return createCodePreviewToolDefinition<TTool>(tool, {
    mode,
    compactSummary: options.compactSummary,
    scheduleAnimation: options.scheduleAnimation,
    // SAFETY: Both callback sets derive their args/details/state from this same tool definition.
    expandedContent: options.expandedContent as CodePreviewToolRenderers<TTool>["expandedContent"],
    renderCall: tool.renderCall ?? ((_args, theme) => renderFallbackToolCall(tool, theme)),
    renderResult: tool.renderResult ?? renderFallbackToolResult,
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
  context: ToolRenderContext<unknown, unknown>,
): Component {
  const output = getFallbackResultText(result.content, context.showImages);
  if (!output) return new Container();
  const color = context.isError ? "error" : options.isPartial ? "warning" : "toolOutput";
  const text = output
    .split("\n")
    .map((line) => theme.fg(color, escapeControlChars(line)))
    .join("\n");
  return new Text(text, 0, 0);
}
