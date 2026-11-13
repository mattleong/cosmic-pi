import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import type { ToolRenderContext } from "../tools/renderers/shared/types";
import { Container, type Component } from "@earendil-works/pi-tui";
import * as Predicate from "effect/Predicate";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import * as Fn from "effect/Function";
import { invokeHostCallback } from "pi-cosmic-core/host-session";
import { clipToWidth } from "pi-cosmic-ui/manager";
import { composeToolComponent, toolStatusLine } from "pi-cosmic-ui/tool";
import { codePreviewSettings } from "../config/state";
import type { CompactIssue } from "../tools/compact-issues";
import { planCompactPresentation } from "../tools/compact-presentation";
import {
  compactStatus,
  type CompactPhase,
  type CompactStatus,
  type CompactSummary,
  type CompactSummaryProvider,
} from "../tools/compact-summary";
import { getTextContent } from "../tools/data/results";
import { renderCompactIssues } from "./compact-issues";
import { reservingHeadingRoom, type HeadingRoom } from "./heading-wrap";

interface PreviewResult<TDetails> {
  readonly result: AgentToolResult<TDetails>;
  readonly partial: boolean;
}

export interface PreviewIssues {
  readonly issues: readonly CompactIssue[];
  readonly cancelled: boolean;
  /** The tool's valid summary; expanded rows compose from it, and without it keep their bodies. */
  readonly summary: CompactSummary | undefined;
  readonly status: CompactStatus;
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

  /** The latest context recorded for a row, which holds no earlier render context. */
  latestFor(state: TState): ToolRenderContext<TState, TArgs> | undefined {
    return this.frames.get(state)?.context;
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

export function previewIssues<TArgs, TDetails, TState extends object>(
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
  if (cached && Arr.every(inputs, (value, index) => Object.is(value, cached.inputs[index])))
    return cached.value;
  const { summary, collapsedSummary } = planCompactPresentation({
    ...compactPresentationInput(provider, phase, result, context),
    expanded: true,
  });
  const status = compactStatus(phase, collapsedSummary);
  const value = {
    summary,
    status,
    issues: collapsedSummary.issues ?? [],
    cancelled: phase === "settled" && context.isError && status === "cancelled",
  };
  frame.issues = { inputs, value };
  return value;
}

/**
 * How a collapsed preview call draws its expansion tag at a width: the columns its heading keeps
 * clear on its first row, decided before it draws, and what then places the tag on its rows, with
 * the columns the tag it placed takes there.
 */
export type PreviewClosing = (width: number) => {
  readonly reserve: number;
  readonly place: (rows: readonly string[]) => {
    readonly rows: readonly string[];
    readonly reserve: number;
  };
};

class PreviewIssuesFrame extends Container {
  readonly body: Component;
  private readonly closing: PreviewClosing | undefined;
  private readonly room: HeadingRoom;

  constructor(
    body: Component,
    issues: Component,
    closing: PreviewClosing | undefined,
    room: HeadingRoom,
  ) {
    super();
    this.body = body;
    this.closing = closing;
    this.room = room;
    this.addChild(body);
    this.addChild(issues);
  }

  override render(width: number): string[] {
    if (!this.closing) return super.render(width);
    const { reserve, place } = this.closing(width);
    this.room.reserve = reserve;
    const placed = place(super.render(width));
    if (placed.reserve === reserve) return [...placed.rows];
    // The rows withdrew the tag, or called for one their result didn't: they wrap again with the
    // room it takes, so no columns stay reserved for a tag that isn't drawn.
    this.room.reserve = placed.reserve;
    return [...place(super.render(width)).rows];
  }
}

const unwrapPreviewIssues = (component: Component | undefined): Component | undefined =>
  component instanceof PreviewIssuesFrame ? component.body : component;

const EMPTY = composeToolComponent(() => []);
const UNSTYLED: Pick<Theme, "fg"> = { fg: (_color, text) => text };

interface IssueSlot {
  readonly lines: Component;
  placed: boolean;
  /** Whether the body is drawn for an expanded row's heading, which the shell captures collapsed. */
  readonly expandedHeading?: true;
}

const issueSlots = new WeakMap<object, IssueSlot>();

/** A preview row's issues, or `Cancelled` for a stop without one; plain if the theme fails. */
export function previewIssueRows(
  value: PreviewIssues,
  theme: Pick<Theme, "fg">,
  width: number,
  expanded: boolean,
  indent: string,
): string[] {
  const draw = (style: Pick<Theme, "fg">) => {
    const rows = renderCompactIssues(value.issues, style, width, expanded, indent);
    return rows.length === 0 && value.cancelled && width > 0
      ? [clipToWidth(`${indent}${toolStatusLine(style, "stopped", "Cancelled")}`, width, "")]
      : rows;
  };
  try {
    return draw(theme);
  } catch {
    return draw(UNSTYLED);
  }
}

export function previewIssuesSlot(context: { readonly state: unknown }): Component {
  if (!Predicate.isObject(context.state)) return EMPTY;
  const slot = issueSlots.get(context.state);
  if (!slot) return EMPTY;
  slot.placed = true;
  return slot.lines;
}

/**
 * Whether a call body draws an expanded row's heading. The shell takes an expanded preview row's
 * heading from the body drawn collapsed, so a heading that differs when expanded, such as a message
 * heading that is one row only collapsed, asks here instead of reading `context.expanded` alone.
 */
export function drawsExpandedHeading(context: {
  readonly expanded: boolean;
  readonly state: unknown;
}): boolean {
  if (context.expanded) return true;
  return Predicate.isObject(context.state)
    ? issueSlots.get(context.state)?.expandedHeading === true
    : false;
}

// Drawn where a call body places its issues slot, so the rows before it are the heading.
const HEADING_END = "\u2063code-previews:heading-end\u2063";
const headingEnd = composeToolComponent(() => [HEADING_END]);

/** A row's collapsed call body, drawn apart from the row. */
export interface CapturedPreviewCall {
  /**
   * The tool's own collapsed preview heading: the rows drawn up to where the body places
   * `previewIssuesSlot`, or every row when it places none. Undefined when the body fails or the
   * heading is blank, so the caller can fall back to a heading built from the summary.
   */
  readonly heading: (width: number) => string[] | undefined;
  /** Every row the collapsed body draws, apart from its issues. */
  readonly rows: (width: number) => readonly string[];
}

export function capturePreviewCall<TArgs, TState extends object>(
  render: (context: ToolRenderContext<TState, TArgs>) => Component,
  context: ToolRenderContext<TState, TArgs>,
): CapturedPreviewCall | undefined {
  if (!Predicate.isObject(context.state)) return undefined;
  issueSlots.set(context.state, { lines: headingEnd, placed: false, expandedHeading: true });
  let body: Component;
  try {
    body = render({ ...context, expanded: false, lastComponent: undefined });
  } catch {
    return undefined;
  } finally {
    issueSlots.delete(context.state);
  }
  let drawn:
    | {
        readonly width: number;
        readonly heading: string[] | undefined;
        readonly rows: readonly string[];
      }
    | undefined;
  const draw = (width: number) => {
    if (drawn?.width === width) return drawn;
    let all: string[];
    try {
      all = body.render(width);
    } catch {
      all = [];
    }
    const end = Arr.findFirstIndex(all, (row) => Fn.pipe(row, Str.includes(HEADING_END)));
    const heading = Option.isSome(end) ? all.slice(0, end.value) : all;
    drawn = {
      width,
      heading: Arr.some(heading, (row) => Str.trim(row) !== "") ? heading : undefined,
      rows: Arr.filter(all, (row) => !Fn.pipe(row, Str.includes(HEADING_END))),
    };
    return drawn;
  };
  return { heading: (width) => draw(width).heading, rows: (width) => draw(width).rows };
}

export function renderWithPreviewIssues<TArgs, TDetails, TState extends object>(
  frames: PreviewFrames<TArgs, TDetails, TState>,
  render: (context: ToolRenderContext<TState, TArgs>) => Component,
  provider: CompactSummaryProvider<TArgs, TDetails, TState>,
  context: ToolRenderContext<TState, TArgs>,
  theme: Theme,
  closing?: PreviewClosing,
): Component {
  frames.frame(context).context = context;
  const detached: ToolRenderContext<TState, TArgs> = { ...context, lastComponent: undefined };
  let drawn:
    | {
        readonly value: PreviewIssues;
        readonly width: number;
        readonly expanded: boolean;
        readonly rows: string[];
      }
    | undefined;
  const lines = composeToolComponent((width) => {
    const current = frames.latest(detached);
    const value = previewIssues(frames, provider, current);
    const { expanded } = current;
    if (drawn?.value === value && drawn.width === width && drawn.expanded === expanded)
      return drawn.rows;
    const rows = previewIssueRows(value, theme, width, expanded, "");
    drawn = { value, width, expanded, rows };
    return rows;
  });
  const slot: IssueSlot = { lines, placed: false };
  issueSlots.set(context.state, slot);
  try {
    // A heading that wraps anyway keeps room on its first row for the tag the closing places.
    const room: HeadingRoom = { reserve: 0 };
    // Passed rather than closed over: a closure here would share this scope, so the long-lived
    // issue rows would retain the context and its replaced arguments.
    const body = reservingHeadingRoom(room, render, {
      ...context,
      lastComponent: unwrapPreviewIssues(context.lastComponent),
    });
    return new PreviewIssuesFrame(body, slot.placed ? EMPTY : lines, closing, room);
  } finally {
    issueSlots.delete(context.state);
  }
}
