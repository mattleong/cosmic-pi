import type {
  AgentToolResult,
  Theme,
  ToolRenderers,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { CompactAnimationScheduler, CompactSummaryProvider } from "./compact-summary";
import type { ToolCallBackgroundMode, ToolCallCollapsedStyle } from "../config/schema";
import { createCodePreviewToolShell } from "../preview/tool-shell";
import type { RendererState, ToolRenderContext } from "./renderers/shared/types";

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

type RenderCall<TTool extends AdaptableToolDefinition> = NonNullable<TTool["renderCall"]>;
type RenderResult<TTool extends AdaptableToolDefinition> = NonNullable<TTool["renderResult"]>;
type WithPreviewState<TContext> = TContext extends object
  ? Omit<TContext, "state"> & { state: RendererState }
  : never;

type PreviewRenderCall<TTool extends AdaptableToolDefinition> = (
  args: Parameters<RenderCall<TTool>>[0],
  theme: Parameters<RenderCall<TTool>>[1],
  context: WithPreviewState<Parameters<RenderCall<TTool>>[2]>,
) => Component;

type PreviewRenderResult<TTool extends AdaptableToolDefinition> = (
  result: Parameters<RenderResult<TTool>>[0],
  options: Parameters<RenderResult<TTool>>[1],
  theme: Parameters<RenderResult<TTool>>[2],
  context: WithPreviewState<Parameters<RenderResult<TTool>>[3]>,
) => Component;

export interface CodePreviewToolRenderers<TTool extends AdaptableToolDefinition> {
  readonly mode?: ToolCallBackgroundMode;
  readonly collapsedStyle?: ToolCallCollapsedStyle | undefined;
  /** Keep a stable self shell for retained rows that adopt settings after construction. */
  readonly selfShell?: boolean | undefined;
  readonly scheduleAnimation?: CompactAnimationScheduler | undefined;
  readonly animateProgress?: boolean | undefined;
  readonly showShortTiming?: boolean | undefined;
  /** Heading name only; the definition's registered `name` is never changed. */
  readonly displayName?: string | undefined;
  readonly compactSummary?:
    | CompactSummaryProvider<
        Parameters<TTool["execute"]>[1],
        Awaited<ReturnType<TTool["execute"]>> extends AgentToolResult<infer TDetails>
          ? TDetails
          : unknown,
        Parameters<RenderCall<TTool>>[2]["state"]
      >
    | undefined;
  readonly expandedContent?:
    | {
        readonly renderCall?: PreviewRenderCall<TTool>;
        readonly renderResult?: PreviewRenderResult<TTool>;
      }
    | undefined;
  readonly renderCall: PreviewRenderCall<TTool>;
  readonly renderResult: PreviewRenderResult<TTool>;
}

function asPreviewContext<TContext extends object>(context: ToolRenderContext): TContext {
  // SAFETY: Pi supplies the mandatory ToolRenderContext object used to derive TContext.
  return context as TContext;
}

type RendererCall = (args: any, theme: Theme, context: any) => Component;
type RendererResult = (
  result: AgentToolResult<any>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: any,
) => Component;

export type CodePreviewRendererCallbacks = Omit<
  CodePreviewToolRenderers<AdaptableToolDefinition>,
  "renderCall" | "renderResult" | "expandedContent" | "compactSummary"
> & {
  readonly compactSummary?: CompactSummaryProvider<any, any, any> | undefined;
  readonly renderCall: RendererCall;
  readonly renderResult: RendererResult;
  readonly expandedContent?:
    | {
        readonly renderCall?: RendererCall;
        readonly renderResult?: RendererResult;
      }
    | undefined;
};

/** Compose renderer callbacks without requiring an execution definition or a parameter schema. */
export function createCodePreviewRenderers(
  identity: { readonly name: string },
  renderers: CodePreviewRendererCallbacks,
): ToolRenderers {
  const previewShell = createCodePreviewToolShell(
    renderers.mode,
    {
      name: renderers.displayName || identity.name,
      animateProgress: renderers.animateProgress,
      showShortTiming: renderers.showShortTiming,
      compactSummary: renderers.compactSummary ?? (() => undefined),
    },
    renderers.scheduleAnimation,
    renderers.selfShell,
    renderers.collapsedStyle,
  );
  const { renderCall, renderResult, expandedContent } = renderers;
  const expandedCall = expandedContent?.renderCall;
  const expandedResult = expandedContent?.renderResult;

  return {
    renderShell: previewShell.renderShell,
    renderCall(args, theme, context) {
      const call =
        (render: CodePreviewRendererCallbacks["renderCall"]) =>
        (renderContext: ToolRenderContext) =>
          render(args, theme, asPreviewContext(renderContext));
      return previewShell.renderCall(
        context,
        theme,
        call(renderCall),
        expandedCall && call(expandedCall),
      );
    },
    renderResult(result, options, theme, context) {
      const call =
        (render: CodePreviewRendererCallbacks["renderResult"]) =>
        (renderContext: ToolRenderContext) =>
          render(result, options, theme, asPreviewContext(renderContext));
      return previewShell.renderResult(
        context,
        theme,
        call(renderResult),
        result,
        expandedResult && call(expandedResult),
      );
    },
  };
}

/** Owned execution definitions share the renderer-only composition, retaining their metadata. */
export function createCodePreviewToolDefinition<TTool extends AdaptableToolDefinition>(
  tool: TTool,
  renderers: CodePreviewToolRenderers<TTool>,
): TTool {
  // SAFETY: Both callback sets derive args, details, and state from the same owned definition.
  const presentation = createCodePreviewRenderers(tool, renderers as CodePreviewRendererCallbacks);
  // SAFETY: Rendering changes preserve the definition's schema and execution signature.
  return { ...tool, ...presentation } as TTool;
}
