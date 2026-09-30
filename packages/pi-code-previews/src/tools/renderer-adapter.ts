import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { CompactAnimationScheduler, CompactSummaryProvider } from "./compact-summary";
import { type ToolCallBackgroundMode } from "../config/schema";
import { createCodePreviewToolShell } from "../preview/tool-shell";
import type { RendererState, ToolRenderContext } from "./renderers/shared/types";

export type AdaptableToolDefinition = {
  readonly name: string;
  readonly label: string;
  readonly execute: (...args: any[]) => Promise<any>;
  readonly renderShell?: "default" | "self";
  readonly renderCall?: (...args: any[]) => Component;
  readonly renderResult?: (...args: any[]) => Component;
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
  readonly scheduleAnimation?: CompactAnimationScheduler | undefined;
  readonly animateProgress?: boolean | undefined;
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
  readonly execute?: (
    ...args: Parameters<TTool["execute"]>
  ) => ReturnType<AdaptableToolDefinition["execute"]>;
  readonly renderCall: PreviewRenderCall<TTool>;
  readonly renderResult: PreviewRenderResult<TTool>;
}

function asPreviewContext<TContext extends object>(context: ToolRenderContext): TContext {
  // SAFETY: Pi supplies the mandatory ToolRenderContext object used to derive TContext.
  return context as TContext;
}

/** Build one tool replacement around the shared code-preview shell. */
export function createCodePreviewToolDefinition<TTool extends AdaptableToolDefinition>(
  tool: TTool,
  renderers: CodePreviewToolRenderers<TTool>,
): TTool {
  const previewShell = createCodePreviewToolShell(
    renderers.mode,
    {
      name: renderers.displayName || tool.name,
      animateProgress: renderers.animateProgress,
      compactSummary: renderers.compactSummary ?? (() => undefined),
    },
    renderers.scheduleAnimation,
  );
  const { renderCall, renderResult, expandedContent } = renderers;
  const expandedCall = expandedContent?.renderCall;
  const expandedResult = expandedContent?.renderResult;

  // SAFETY: The adapter preserves the definition's generic schema, details, and renderer state.
  return {
    ...tool,
    execute: renderers.execute ?? tool.execute,
    renderShell: previewShell.renderShell,
    renderCall(args, theme, context) {
      const call = (render: PreviewRenderCall<TTool>) => (renderContext: ToolRenderContext) =>
        render(args, theme, asPreviewContext(renderContext));
      return previewShell.renderCall(
        context,
        theme,
        call(renderCall),
        expandedCall && call(expandedCall),
      );
    },
    renderResult(result, options, theme, context) {
      const call = (render: PreviewRenderResult<TTool>) => (renderContext: ToolRenderContext) =>
        render(result, options, theme, asPreviewContext(renderContext));
      return previewShell.renderResult(
        context,
        theme,
        call(renderResult),
        result,
        expandedResult && call(expandedResult),
      );
    },
  } as TTool;
}
