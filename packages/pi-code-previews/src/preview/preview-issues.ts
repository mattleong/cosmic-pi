/**
 * Preview style's shared issue lines. They come from the tool's compact summary, so preview and
 * compact styles report the same problems in the same words, and sit between the tool's own
 * call and result bodies. Tools render only their bodies; the shell owns attention.
 */
import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { Container, type Component } from "@earendil-works/pi-tui";
import * as Predicate from "effect/Predicate";
import { clipToWidth } from "pi-cosmic-ui/manager";
import { toolStatusLine } from "pi-cosmic-ui/tool";
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
import type { RendererState, ToolRenderContext } from "../tools/renderers/shared/types";
import { renderCompactIssues } from "./compact-issues";

type Provider = CompactSummaryProvider<any, any, any>;
type Context = ToolRenderContext<any, any>;

interface PreviewResult {
  readonly result: AgentToolResult<unknown>;
  readonly partial: boolean;
}

type FrameState = RendererState & {
  codePreviewFrameResult?: PreviewResult | undefined;
  codePreviewFrameContext?: Context | undefined;
  codePreviewIssueSlot?: IssueSlot | undefined;
};

function frameState(context: { readonly state: unknown }): FrameState {
  // SAFETY: Pi initializes renderer state as an object shared by the call and result slots.
  return context.state as FrameState;
}

/** The newest render context; Pi renders both slots per update, but either may come last. */
const latestContext = (context: Context): Context =>
  frameState(context).codePreviewFrameContext ?? context;

interface PreviewIssues {
  readonly issues: readonly CompactIssue[];
  readonly cancelled: boolean;
}

const cache = new WeakMap<object, { inputs: readonly unknown[]; value: PreviewIssues }>();

/** Remembers the result Pi last rendered, so the call slot can explain it. */
export function recordPreviewResult(
  context: Context,
  result: AgentToolResult<unknown> | undefined,
): void {
  const state = frameState(context);
  state.codePreviewFrameContext = context;
  if (result) state.codePreviewFrameResult = { result, partial: context.isPartial };
}

function currentResult(context: Context): AgentToolResult<unknown> | undefined {
  const recorded = frameState(context).codePreviewFrameResult;
  // Pi renders the call before the result; a retained streaming result is not a final one.
  return recorded && recorded.partial === context.isPartial ? recorded.result : undefined;
}

function previewIssues(provider: Provider, context: Context): PreviewIssues {
  const result = currentResult(context);
  const phase: CompactPhase =
    result && !context.isPartial ? "settled" : context.executionStarted ? "running" : "pending";
  // Pi builds a new result envelope on every update, including each animation tick, but keeps
  // its content and details. Settings replace atomically, covering the policy providers read.
  const inputs = [
    result?.content,
    result?.details,
    context.args,
    context.isError,
    phase,
    codePreviewSettings,
  ];
  const cached = cache.get(context.state);
  if (cached && inputs.every((value, index) => Object.is(value, cached.inputs[index])))
    return cached.value;
  let summary: CompactSummary | undefined;
  try {
    summary = provider({ phase, args: context.args, result, context });
  } catch {
    summary = undefined;
  }
  const { collapsedSummary } = planCompactPresentation({
    summary,
    phase,
    isError: context.isError,
    errorText: context.isError ? getTextContent(result?.content ?? []) : "",
    expanded: true,
  });
  const value = {
    issues: collapsedSummary.issues ?? [],
    // Only a call Pi itself reports as aborted says so here; a producer's cancelled outcome,
    // such as a stopped task, is already stated by the tool's own body.
    cancelled:
      phase === "settled" &&
      context.isError &&
      compactStatus(phase, collapsedSummary) === "cancelled",
  };
  cache.set(context.state, { inputs, value });
  return value;
}

/** A tool's call body with the shell's issue lines beneath it. */
class PreviewIssuesFrame extends Container {
  readonly body: Component;

  constructor(body: Component, issues: Component) {
    super();
    this.body = body;
    this.addChild(body);
    this.addChild(issues);
  }
}

/** The tool's own component, so it can reuse what it rendered last time. */
export const unwrapPreviewIssues = (component: Component | undefined): Component | undefined =>
  component instanceof PreviewIssuesFrame ? component.body : component;

const EMPTY: Component = { render: () => [], invalidate: () => undefined };
const UNSTYLED: Pick<Theme, "fg"> = { fg: (_color, text) => text };

interface IssueSlot {
  readonly lines: Component;
  placed: boolean;
}

/**
 * The shell's issue lines for a tool that shows content under its heading, such as a diff, and
 * wants warnings above it. Tools that do not place them get them after their call body.
 */
export function previewIssuesSlot(context: { readonly state: unknown }): Component {
  if (!Predicate.isObject(context.state)) return EMPTY;
  const slot = frameState(context).codePreviewIssueSlot;
  if (!slot) return EMPTY;
  slot.placed = true;
  return slot.lines;
}

/**
 * Renders the tool's call body with the issue lines compact style would show, computed when
 * drawn so they follow the latest result. A cancelled call without issues says so.
 */
export function renderWithPreviewIssues(
  render: (context: Context) => Component,
  provider: Provider,
  context: Context,
  theme: Theme,
): Component {
  const state = frameState(context);
  state.codePreviewFrameContext = context;
  const lines: Component = {
    render: (width) => {
      const current = latestContext(context);
      const { issues, cancelled } = previewIssues(provider, current);
      const draw = (style: Pick<Theme, "fg">) => {
        const rows = renderCompactIssues(issues, style, width, current.expanded, "");
        return rows.length === 0 && cancelled && width > 0
          ? [clipToWidth(toolStatusLine(style, "stopped", "Cancelled"), width, "")]
          : rows;
      };
      try {
        return draw(theme);
      } catch {
        // A failing host theme cannot hide what went wrong, nor widen the row past the terminal.
        return draw(UNSTYLED);
      }
    },
    invalidate: () => undefined,
  };
  const slot: IssueSlot = { lines, placed: false };
  state.codePreviewIssueSlot = slot;
  try {
    const body = render({ ...context, lastComponent: unwrapPreviewIssues(context.lastComponent) });
    return new PreviewIssuesFrame(body, slot.placed ? EMPTY : lines);
  } finally {
    state.codePreviewIssueSlot = undefined;
  }
}
