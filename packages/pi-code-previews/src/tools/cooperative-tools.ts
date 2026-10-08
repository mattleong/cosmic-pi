import type {
  AgentToolResult,
  Theme,
  ToolDefinition,
  ToolRenderers,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { getFallbackResultText } from "./data/results";
import type { ToolCallBackgroundMode, ToolCallCollapsedStyle } from "../config/schema";
import { codePreviewSettings } from "../config/state";
import { createCodePreviewToolShell } from "../preview/tool-shell";
import { escapeControlChars } from "../shared/terminal-text";
import type { CompactAnimationScheduler, CompactSummaryProvider } from "./compact-summary";
import type { PreviewRenderers, ToolRenderContext } from "./renderers/shared/types";

export type AdaptableToolRenderers = {
  readonly name: string;
  readonly label?: string;
  readonly renderShell?: "default" | "self";
  readonly renderCall?: (...args: any[]) => Component;
  readonly renderResult?: (...args: any[]) => Component;
};

export type AdaptableToolDefinition = AdaptableToolRenderers & {
  readonly label: string;
  readonly execute: (...args: any[]) => Promise<any>;
};

export interface CodePreviewShellOptions<TArgs = unknown, TDetails = unknown, TState = unknown> {
  /**
   * Shell mode to apply. Defaults to the code-preview setting at wrapping time.
   * The selected mode is captured; later settings reloads do not change the wrapped tool.
   */
  mode?: ToolCallBackgroundMode;

  /** Optional originating-session style; otherwise captured from settings when wrapped. */
  collapsedStyle?: ToolCallCollapsedStyle;

  /** Keep framing inside the renderer for rows retained before session settings are ready. */
  selfShell?: boolean;

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

  /** Display measured subsecond durations; the global timing setting still applies. */
  showShortTiming?: boolean;

  /** Keep visible progress animated in preview/expanded views even when timing is disabled. */
  animateProgress?: boolean;

  /** Session-owned scheduler. Independent extension loaders cannot share previews' runtime. */
  scheduleAnimation?: CompactAnimationScheduler | undefined;

  /**
   * Human tool name for shell headings, such as `mcp`. Presentation only: the registered
   * `name` Pi and the model use is unchanged. Defaults to the tool's name.
   */
  displayName?: string | undefined;
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
  const renderers = withCodePreviewRenderers(tool, tool, options);
  // SAFETY: Rendering changes preserve the definition's schema and execution signature.
  return renderers === tool ? tool : ({ ...tool, ...renderers } as TTool);
}

/**
 * Compose presentation for Pi's renderer resolver without creating or replacing a tool. Shell mode
 * and collapsed style are captured here; callbacks are invoked unbound.
 */
export function withCodePreviewRenderers<TArgs = any, TDetails = any, TState = any>(
  identity: { readonly name: string; readonly label?: string },
  renderers: Pick<AdaptableToolRenderers, "renderShell" | "renderCall" | "renderResult">,
  options: CodePreviewShellOptions<TArgs, TDetails, TState> = {},
): ToolRenderers {
  if (
    (options.preserveSelfShell ?? true) &&
    renderers.renderShell === "self" &&
    (options.collapsedStyle ?? codePreviewSettings.toolCallCollapsedStyle) !== "compact"
  )
    // SAFETY: The original callback types are specializations of Pi's rendering contract.
    return renderers as ToolRenderers;
  const shell = createCodePreviewToolShell(
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
  const renderCall: PreviewRenderers["renderCall"] =
    renderers.renderCall ?? ((_args, theme) => renderFallbackToolCall(identity, theme));
  const renderResult: PreviewRenderers["renderResult"] =
    renderers.renderResult ?? renderFallbackToolResult;
  const { renderCall: expandedCall, renderResult: expandedResult } = options.expandedContent ?? {};
  return {
    renderShell: shell.renderShell,
    renderCall(args, theme, context) {
      const call = (render: PreviewRenderers["renderCall"]) => (current: ToolRenderContext) =>
        render(args, theme, current);
      return shell.renderCall(context, theme, call(renderCall), expandedCall && call(expandedCall));
    },
    renderResult(result, resultOptions, theme, context) {
      const call = (render: PreviewRenderers["renderResult"]) => (current: ToolRenderContext) =>
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

function renderFallbackToolCall(
  tool: { readonly name: string; readonly label?: string },
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
