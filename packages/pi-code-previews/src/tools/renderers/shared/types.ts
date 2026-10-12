import type {
  AgentToolResult,
  Theme,
  ToolRenderers,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { DiffSummary } from "../../../diff/summary";
import type { HostObject } from "../../../shared/untrusted-value";

type HostToolRenderContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];

export type ToolRenderContext<TState, TArgs> = Omit<HostToolRenderContext, "state" | "args"> & {
  state: TState;
  args: TArgs;
};

export type EditProposedDiff =
  | { readonly kind: "diff"; readonly diff: string; readonly summary: DiffSummary }
  | { readonly kind: "skipped"; readonly guard: "size" | "complexity" };

export interface RendererState {
  writeNewFile?: boolean;
  editArgsPath?: string;
  editArgsExactSource?: string;
  editSummaryText?: string | undefined;
  editProposedDiffs?: {
    readonly source: string;
    readonly diffs: Array<EditProposedDiff | undefined>;
  };
  codePreviewWriteBeforeSnapshot?: HostObject | undefined;
  codePreviewResultDiffShown?: boolean;
  codePreviewTimingStartedAt?: number | undefined;
  codePreviewTimingEndedAt?: number | undefined;
  codePreviewAnimationFrame?: number;
}

export type RenderCall<TArgs, TState> = (
  args: TArgs,
  theme: Theme,
  context: ToolRenderContext<TState, TArgs>,
) => Component;

export type RenderResult<TArgs, TDetails, TState> = (
  result: AgentToolResult<TDetails>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: ToolRenderContext<TState, TArgs>,
) => Component;

export interface CodePreviewRenderers<TArgs, TDetails, TState> {
  readonly renderShell?: "default" | "self";
  readonly renderCall?: RenderCall<TArgs, TState>;
  readonly renderResult?: RenderResult<TArgs, TDetails, TState>;
}

export type PreviewRenderers = Required<
  Pick<CodePreviewRenderers<unknown, unknown, RendererState>, "renderCall" | "renderResult">
>;
