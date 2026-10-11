import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import type { ToolRenderContext } from "../tools/renderers/shared/types";
import { Container, type Component } from "@earendil-works/pi-tui";
import * as Predicate from "effect/Predicate";
import { invokeHostCallback } from "pi-cosmic-core";
import { clipToWidth } from "pi-cosmic-ui/manager";
import { composeToolComponent, toolStatusLine } from "pi-cosmic-ui/tool";
import { codePreviewSettings } from "../config/state";
import type { CompactIssue } from "../tools/compact-issues";
import { planCompactPresentation } from "../tools/compact-presentation";
import {
  compactStatus,
  type CompactPhase,
  type CompactSummary,
  type CompactSummaryProvider,
} from "../tools/compact-summary";
import { getTextContent } from "../tools/data/results";
import { renderCompactIssues } from "./compact-issues";

interface PreviewResult<TDetails> {
  readonly result: AgentToolResult<TDetails>;
  readonly partial: boolean;
}

interface PreviewIssues {
  readonly issues: readonly CompactIssue[];
  readonly cancelled: boolean;
}

interface PreviewFrame<TArgs, TDetails, TState> {
  context?: ToolRenderContext<TState, TArgs> | undefined;
  result?: PreviewResult<TDetails> | undefined;
  issues?: { readonly inputs: readonly unknown[]; readonly value: PreviewIssues } | undefined;
}

export class PreviewFrames<TArgs, TDetails, TState extends object> {
  private readonly frames = new WeakMap<object, PreviewFrame<TArgs, TDetails, TState>>();

  frame(context: ToolRenderContext<TState, TArgs>): PreviewFrame<TArgs, TDetails, TState> {
    const existing = this.frames.get(context.state);
    if (existing) return existing;
    const created: PreviewFrame<TArgs, TDetails, TState> = {};
    this.frames.set(context.state, created);
    return created;
  }

  record(context: ToolRenderContext<TState, TArgs>, result: AgentToolResult<TDetails>): void {
    const frame = this.frame(context);
    frame.context = context;
    frame.result = { result, partial: context.isPartial };
  }

  latest(context: ToolRenderContext<TState, TArgs>): ToolRenderContext<TState, TArgs> {
    return this.frame(context).context ?? context;
  }

  currentResult(context: ToolRenderContext<TState, TArgs>): AgentToolResult<TDetails> | undefined {
    const recorded = this.frame(context).result;
    return recorded && recorded.partial === context.isPartial ? recorded.result : undefined;
  }
}

export const compactPhase = <TArgs, TDetails, TState>(
  result: AgentToolResult<TDetails> | undefined,
  context: ToolRenderContext<TState, TArgs>,
): CompactPhase =>
  result && !context.isPartial ? "settled" : context.executionStarted ? "running" : "pending";

export const compactPresentationInput = <TArgs, TDetails, TState>(
  provider: CompactSummaryProvider<TArgs, TDetails, TState>,
  phase: CompactPhase,
  result: AgentToolResult<TDetails> | undefined,
  context: ToolRenderContext<TState, TArgs>,
) => ({
  summary: invokeHostCallback<CompactSummary | undefined>(
    () => provider({ phase, args: context.args, result, context }),
    undefined,
  ),
  phase,
  isError: context.isError,
  errorText: context.isError ? getTextContent(result?.content ?? []) : "",
});

function previewIssues<TArgs, TDetails, TState extends object>(
  frames: PreviewFrames<TArgs, TDetails, TState>,
  provider: CompactSummaryProvider<TArgs, TDetails, TState>,
  context: ToolRenderContext<TState, TArgs>,
): PreviewIssues {
  const result = frames.currentResult(context);
  const phase = compactPhase(result, context);
  const inputs = [
    result?.content,
    result?.details,
    context.args,
    context.isError,
    phase,
    codePreviewSettings,
  ];
  const frame = frames.frame(context);
  const cached = frame.issues;
  if (cached && inputs.every((value, index) => Object.is(value, cached.inputs[index])))
    return cached.value;
  const { collapsedSummary } = planCompactPresentation({
    ...compactPresentationInput(provider, phase, result, context),
    expanded: true,
  });
  const value = {
    issues: collapsedSummary.issues ?? [],
    cancelled:
      phase === "settled" &&
      context.isError &&
      compactStatus(phase, collapsedSummary) === "cancelled",
  };
  frame.issues = { inputs, value };
  return value;
}

class PreviewIssuesFrame extends Container {
  readonly body: Component;

  constructor(body: Component, issues: Component) {
    super();
    this.body = body;
    this.addChild(body);
    this.addChild(issues);
  }
}

const unwrapPreviewIssues = (component: Component | undefined): Component | undefined =>
  component instanceof PreviewIssuesFrame ? component.body : component;

const EMPTY = composeToolComponent(() => []);
const UNSTYLED: Pick<Theme, "fg"> = { fg: (_color, text) => text };

interface IssueSlot {
  readonly lines: Component;
  placed: boolean;
}

const issueSlots = new WeakMap<object, IssueSlot>();

export function previewIssuesSlot(context: { readonly state: unknown }): Component {
  if (!Predicate.isObject(context.state)) return EMPTY;
  const slot = issueSlots.get(context.state);
  if (!slot) return EMPTY;
  slot.placed = true;
  return slot.lines;
}

export function renderWithPreviewIssues<TArgs, TDetails, TState extends object>(
  frames: PreviewFrames<TArgs, TDetails, TState>,
  render: (context: ToolRenderContext<TState, TArgs>) => Component,
  provider: CompactSummaryProvider<TArgs, TDetails, TState>,
  context: ToolRenderContext<TState, TArgs>,
  theme: Theme,
): Component {
  frames.frame(context).context = context;
  const detached: ToolRenderContext<TState, TArgs> = { ...context, lastComponent: undefined };
  const lines = composeToolComponent((width) => {
    const current = frames.latest(detached);
    const { issues, cancelled } = previewIssues(frames, provider, current);
    const draw = (style: Pick<Theme, "fg">) => {
      const rows = renderCompactIssues(issues, style, width, current.expanded, "");
      return rows.length === 0 && cancelled && width > 0
        ? [clipToWidth(toolStatusLine(style, "stopped", "Cancelled"), width, "")]
        : rows;
    };
    try {
      return draw(theme);
    } catch {
      return draw(UNSTYLED);
    }
  });
  const slot: IssueSlot = { lines, placed: false };
  issueSlots.set(context.state, slot);
  try {
    const body = render({ ...context, lastComponent: unwrapPreviewIssues(context.lastComponent) });
    return new PreviewIssuesFrame(body, slot.placed ? EMPTY : lines);
  } finally {
    issueSlots.delete(context.state);
  }
}
