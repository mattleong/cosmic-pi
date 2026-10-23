import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import type { ToolRenderContext } from "../tools/renderers/shared/types";
import { Box, Container, Text, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import * as Schema from "effect/Schema";
import { composeToolComponent } from "pi-cosmic-ui/tool";
import type { ToolCallBackgroundMode } from "../config/schema";
import { codePreviewSettings } from "../config/state";
import { escapeControlChars } from "../shared/terminal-text";
import { fallbackArguments } from "../tools/data/args";
import { hostValue } from "../shared/untrusted-value";
import { getFallbackResultText } from "../tools/data/results";
import {
  compactStatus,
  resolveCompactSummary,
  type CompactAnimationScheduler,
  type CompactPhase,
  type CompactStatus,
  type CompactSummary,
  type CompactSummaryProvider,
} from "../tools/compact-summary";
import {
  BorderedToolCall,
  borderColorKey,
  borderState,
  renderWithBorderSlot,
} from "./bordered-tool-call";
import { renderCompactIssues } from "./compact-issues";
import { renderCompactRow } from "./compact-row";
import { renderCompactToolCall } from "./compact-tool-call";
import { planCompactPresentation } from "../tools/compact-presentation";
import { compactPhase, compactPresentationInput } from "./preview-issues";
import { resultStandIn, rowPerState } from "./self-background";
import {
  getCodePreviewAnimationFrame,
  updateToolCallTiming,
  type ToolCallTiming,
} from "./tool-timing";
import type { CodePreviewToolShell, ShellRenderBody } from "./tool-shell";
import { CompactSlots, CompactSlotDrawFailure, type CompactSlot } from "./compact-slots";

const isSlotDrawFailure = Schema.is(CompactSlotDrawFailure);

export interface CompactShellOptions<TArgs, TDetails, TState> {
  name: string;
  compactSummary: CompactSummaryProvider<TArgs, TDetails, TState>;
  scheduleAnimation?: CompactAnimationScheduler | undefined;
  animateProgress?: boolean | undefined;
  showShortTiming?: boolean | undefined;
}

interface CompactPlan {
  readonly phase: CompactPhase;
  readonly summary: CompactSummary | undefined;
  readonly collapsedSummary: CompactSummary;
}

class CompactShell<TArgs, TDetails, TState> implements Component {
  private context: ToolRenderContext<TState, TArgs>;
  private theme: Theme;
  private callRender: ShellRenderBody<TArgs, TState> | undefined;
  private resultRender: ShellRenderBody<TArgs, TState> | undefined;
  private contentCallRender: ShellRenderBody<TArgs, TState> | undefined;
  private contentResultRender: ShellRenderBody<TArgs, TState> | undefined;
  private readonly slots = new CompactSlots<TArgs, TDetails, TState>();
  private result: AgentToolResult<TDetails> | undefined;
  private resultPartial: boolean | undefined;
  private callMounted = false;
  private timing: ToolCallTiming | undefined;
  private display: Component | undefined;
  private planned: { settings: object; plan: CompactPlan } | undefined;
  private collapsed:
    | { plan: CompactPlan; width: number; frame: number | undefined; rows: string[] }
    | undefined;
  private detailBounds: { height: number; width: number } | undefined;
  private readonly mode: ToolCallBackgroundMode;
  private readonly options: CompactShellOptions<TArgs, TDetails, TState>;
  readonly resultSlot = resultStandIn(this, () => this.callMounted);

  constructor(
    mode: ToolCallBackgroundMode,
    options: CompactShellOptions<TArgs, TDetails, TState>,
    context: ToolRenderContext<TState, TArgs>,
    theme: Theme,
  ) {
    this.mode = mode;
    this.options = options;
    this.context = context;
    this.theme = theme;
  }

  setCall(
    context: ToolRenderContext<TState, TArgs>,
    theme: Theme,
    render: ShellRenderBody<TArgs, TState>,
    content?: ShellRenderBody<TArgs, TState>,
  ): void {
    this.callMounted = true;
    this.callRender = render;
    this.contentCallRender = content;
    this.update(context, theme);
  }

  setResult(
    context: ToolRenderContext<TState, TArgs>,
    theme: Theme,
    render: ShellRenderBody<TArgs, TState>,
    result: AgentToolResult<TDetails>,
    content?: ShellRenderBody<TArgs, TState>,
  ): void {
    this.result = result;
    this.resultPartial = context.isPartial;
    this.resultRender = render;
    this.contentResultRender = content;
    this.update(context, theme);
  }

  private update(context: ToolRenderContext<TState, TArgs>, theme: Theme): void {
    this.slots.update(context, this.result);
    this.context = context;
    this.theme = theme;
    this.forget();
    this.timing = updateToolCallTiming(context, {
      animateWithoutTiming:
        (!context.expanded || this.options.animateProgress === true) && !context.isError,
      scheduleAnimation: this.options.scheduleAnimation,
      showShortTiming: this.options.showShortTiming,
    });
  }

  private forget(): void {
    this.display = undefined;
    this.planned = undefined;
    this.collapsed = undefined;
    this.detailBounds = undefined;
  }

  private currentResult(): AgentToolResult<TDetails> | undefined {
    return this.resultPartial === this.context.isPartial ? this.result : undefined;
  }

  private plan(result: AgentToolResult<TDetails> | undefined): CompactPlan {
    const settings = codePreviewSettings;
    if (this.planned?.settings !== settings)
      this.planned = { settings, plan: this.computePlan(result) };
    return this.planned.plan;
  }

  private computePlan(result: AgentToolResult<TDetails> | undefined): CompactPlan {
    const phase = compactPhase(result, this.context);
    const provider = this.options.compactSummary;
    const input = compactPresentationInput(provider, phase, result, this.context);
    const presented = planCompactPresentation(input);
    if (presented.summary) return { phase, ...presented };
    const argumentsOnly = { ...this.context, isError: false, isPartial: true };
    const { summary } = compactPresentationInput(provider, "pending", undefined, argumentsOnly);
    const heading = resolveCompactSummary(summary, "pending", false);
    return { phase, ...planCompactPresentation({ ...input, summary: undefined, heading }) };
  }

  render(width: number): string[] {
    const result = this.currentResult();
    const plan = this.plan(result);
    if (!this.context.expanded) {
      this.detailBounds = undefined;
      const frame = getCodePreviewAnimationFrame(this.context);
      const cached = this.collapsed;
      if (cached?.plan === plan && cached.width === width && cached.frame === frame)
        return cached.rows;
      const rows = renderCompactToolCall(
        {
          name: this.options.name,
          phase: plan.phase,
          summary: plan.collapsedSummary,
          duration: this.timing?.duration,
          elapsedMs: this.timing?.elapsedMs,
          timingEnabled: codePreviewSettings.toolCallTiming,
          animationFrame: frame,
        },
        this.theme,
        width,
      );
      this.collapsed = { plan, width, frame, rows };
      return rows;
    }
    this.display ??= this.renderDetails(result !== undefined, plan);
    let rows: string[];
    for (;;) {
      try {
        rows = this.display.render(width);
        break;
      } catch (error) {
        if (!isSlotDrawFailure(error)) throw error;
        this.display = this.renderDetails(result !== undefined, plan, true);
      }
    }
    this.detailBounds = { height: rows.length, width };
    return rows;
  }

  private renderDetails(hasResult: boolean, plan: CompactPlan, reuse = false): Component {
    const { summary } = plan;
    const status = compactStatus(plan.phase, plan.collapsedSummary);
    const content = Boolean(summary && (this.contentCallRender ?? this.contentResultRender));
    const callBody = this.detailSlot(
      "call",
      content,
      reuse,
      this.callRender,
      this.contentCallRender,
    );
    const resultBody = hasResult
      ? this.detailSlot("result", content, reuse, this.resultRender, this.contentResultRender)
      : this.detailSlot("result", content, reuse);
    const issues = composeToolComponent((width) =>
      renderCompactIssues(summary?.issues, this.theme, width, true),
    );
    const callSection = new Container();
    if (content && summary) {
      callSection.addChild(this.expandedHeading(plan.phase, summary));
      callSection.addChild(issues);
    }
    if (callBody) callSection.addChild(callBody);
    const details = new Container();
    if (!content) details.addChild(issues);
    if (resultBody) details.addChild(resultBody);
    return this.mode === "border"
      ? this.borderedDetails(callSection, details, status)
      : this.backgroundDetails(callSection, details, status, content);
  }

  private detailSlot(
    name: CompactSlot,
    content: boolean,
    reuse: boolean,
    original?: ShellRenderBody<TArgs, TState>,
    unique?: ShellRenderBody<TArgs, TState>,
  ): Component | undefined {
    const { context } = this;
    const contentOnly = content && unique !== undefined;
    const render = contentOnly ? unique : original;
    const build = () =>
      render &&
      this.slots.construct(
        name,
        contentOnly,
        render,
        context,
        () => this.fallbackSlot(name, context),
        reuse,
      );
    return this.mode === "border"
      ? renderWithBorderSlot(borderState(context), name, build)
      : build();
  }

  private expandedHeading(phase: CompactPhase, summary: CompactSummary): Component {
    const { context, theme, timing } = this;
    const timingEnabled = this.mode !== "border" && codePreviewSettings.toolCallTiming;
    return composeToolComponent((width) => [
      renderCompactRow(
        {
          name: this.options.name,
          expanded: true,
          phase,
          summary,
          duration: timing?.duration,
          elapsedMs: timing?.elapsedMs,
          timingEnabled,
          animationFrame: getCodePreviewAnimationFrame(context),
        },
        theme,
        width,
      ),
    ]);
  }

  private borderedDetails(
    callSection: Component,
    details: Component,
    status: CompactStatus,
  ): Component {
    const shell = new BorderedToolCall(this.theme);
    const color =
      status === "cancelled"
        ? "borderMuted"
        : status === "warning" || status === "uncertain"
          ? "warning"
          : borderColorKey({ isError: status === "error", isPartial: this.context.isPartial });
    shell.setContent(callSection, details, borderState(this.context), color, this.timing?.label);
    return shell;
  }

  private backgroundDetails(
    callSection: Component,
    details: Component,
    status: CompactStatus,
    content: boolean,
  ): Component {
    const { context, theme, timing } = this;
    const background =
      status === "error"
        ? "toolErrorBg"
        : context.isPartial || status === "cancelled" || status === "uncertain"
          ? "toolPendingBg"
          : "toolSuccessBg";
    const shell =
      this.mode === "on" ? new Box(1, 1, (text) => theme.bg(background, text)) : new Container();
    shell.addChild(callSection);
    shell.addChild(details);
    if (timing && !content) shell.addChild(new Text(theme.fg("muted", `╰─ ${timing.label}`), 0, 0));
    return shell;
  }

  private fallbackSlot(slot: CompactSlot, context: ToolRenderContext<TState, TArgs>): Component {
    if (slot === "result") {
      const color = context.isError ? "error" : "toolOutput";
      return new Text(this.theme.fg(color, escapeControlChars(this.fallbackResultText())), 0, 0);
    }
    const lines = [
      this.theme.fg("toolTitle", escapeControlChars(this.options.name)),
      ...fallbackArguments(hostValue(context.args)).map((line) => this.theme.fg("muted", line)),
    ];
    return new Text(lines.join("\n"), 0, 0);
  }

  private fallbackResultText(): string {
    return getFallbackResultText(this.currentResult()?.content ?? [], this.context.showImages);
  }

  handleMouse(event: TuiMouseEvent) {
    const bounds = this.detailBounds;
    if (!bounds || !this.display || bounds.width !== event.width) return undefined;
    if (event.y < 0 || event.y >= bounds.height) return undefined;
    return this.display.handleMouse?.({ ...event, height: bounds.height });
  }

  invalidate(): void {
    this.forget();
    this.slots.invalidate();
  }
}

export function createCompactToolShell<TArgs, TDetails, TState extends object>(
  mode: ToolCallBackgroundMode,
  options: CompactShellOptions<TArgs, TDetails, TState>,
): CodePreviewToolShell<TArgs, TDetails, TState> {
  const row = rowPerState<TArgs, TState, CompactShell<TArgs, TDetails, TState>>(
    (context, theme) => new CompactShell(mode, options, context, theme),
  );
  return {
    renderShell: "self",
    renderCall(context, theme, render, content) {
      const shell = row(context, theme);
      shell.setCall(context, theme, render, content);
      return shell;
    },
    renderResult(context, theme, render, result, content) {
      const shell = row(context, theme);
      shell.setResult(context, theme, render, result, content);
      return shell.resultSlot;
    },
  };
}
