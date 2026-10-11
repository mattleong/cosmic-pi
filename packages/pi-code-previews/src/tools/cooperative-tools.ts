import type {
  AgentToolResult,
  Theme,
  ToolDefinition,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { fallbackArguments } from "./data/args";
import { getFallbackResultText } from "./data/results";
import type { ToolCallBackgroundMode, ToolCallCollapsedStyle } from "../config/schema";
import { codePreviewSettings } from "../config/state";
import { createCodePreviewToolShell } from "../preview/tool-shell";
import { escapeControlChars } from "../shared/terminal-text";
import type { CompactAnimationScheduler, CompactSummaryProvider } from "./compact-summary";
import type {
  CodePreviewRenderers,
  RenderCall,
  RenderResult,
  ToolRenderContext,
} from "./renderers/shared/types";

export interface CodePreviewShellOptions<TArgs = unknown, TDetails = unknown, TState = unknown> {
  mode?: ToolCallBackgroundMode;

  collapsedStyle?: ToolCallCollapsedStyle;

  selfShell?: boolean;

  preserveSelfShell?: boolean;

  compactSummary?: CompactSummaryProvider<TArgs, TDetails, TState>;

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

  showShortTiming?: boolean;

  animateProgress?: boolean;

  scheduleAnimation?: CompactAnimationScheduler | undefined;

  displayName?: string | undefined;
}

type ToolArgs<TParams extends ToolDefinition["parameters"]> = Parameters<
  ToolDefinition<TParams>["execute"]
>[1];

export function withCodePreviewShell<
  TParams extends ToolDefinition["parameters"],
  TDetails,
  TState extends object,
  TTool extends ToolDefinition<TParams, TDetails, TState>,
>(
  tool: ToolDefinition<TParams, TDetails, TState> & TTool,
  options: CodePreviewShellOptions<ToolArgs<TParams>, TDetails, TState> = {},
): TTool {
  const renderers = withCodePreviewRenderers<ToolArgs<TParams>, TDetails, TState>(
    tool,
    tool,
    options,
  );
  return renderers === tool ? tool : { ...tool, ...renderers };
}

export function withCodePreviewRenderers<TArgs, TDetails, TState extends object>(
  identity: { readonly name: string; readonly label?: string },
  renderers: CodePreviewRenderers<TArgs, TDetails, TState>,
  options: CodePreviewShellOptions<TArgs, TDetails, TState> = {},
): CodePreviewRenderers<TArgs, TDetails, TState> {
  if (
    (options.preserveSelfShell ?? true) &&
    renderers.renderShell === "self" &&
    (options.collapsedStyle ?? codePreviewSettings.toolCallCollapsedStyle) !== "compact"
  )
    return renderers;
  const shell = createCodePreviewToolShell<TArgs, TDetails, TState>(
    options.mode,
    {
      name: options.displayName || identity.name,
      animateProgress: options.animateProgress,
      showShortTiming: options.showShortTiming,
      scheduleAnimation: options.scheduleAnimation,
      compactSummary: options.compactSummary ?? (() => undefined),
    },
    options.selfShell,
    options.collapsedStyle,
  );
  const renderCall: RenderCall<TArgs, TState> =
    renderers.renderCall ??
    ((args, theme, context) => renderFallbackToolCall(identity, theme, args, context.expanded));
  const renderResult: RenderResult<TArgs, TDetails, TState> =
    renderers.renderResult ?? renderFallbackToolResult;
  const { renderCall: expandedCall, renderResult: expandedResult } = options.expandedContent ?? {};
  return {
    renderShell: shell.renderShell,
    renderCall(args, theme, context) {
      const call =
        (render: RenderCall<TArgs, TState>) => (current: ToolRenderContext<TState, TArgs>) =>
          render(args, theme, current);
      return shell.renderCall(context, theme, call(renderCall), expandedCall && call(expandedCall));
    },
    renderResult(result, resultOptions, theme, context) {
      const call =
        (render: RenderResult<TArgs, TDetails, TState>) =>
        (current: ToolRenderContext<TState, TArgs>) =>
          render(result, resultOptions, theme, current);
      return shell.renderResult(
        context,
        theme,
        call(renderResult),
        result,
        expandedResult && call(expandedResult),
      );
    },
  };
}

function renderFallbackToolCall<TArgs>(
  tool: { readonly name: string; readonly label?: string },
  theme: Theme,
  args: TArgs,
  expanded: boolean,
): Component {
  const lines = [
    theme.fg("toolTitle", theme.bold(tool.label || tool.name)),
    ...(expanded ? fallbackArguments(args).map((line) => theme.fg("muted", line)) : []),
  ];
  return new Text(lines.join("\n"), 0, 0);
}

function renderFallbackToolResult<TArgs, TDetails, TState>(
  result: AgentToolResult<TDetails>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: ToolRenderContext<TState, TArgs>,
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
