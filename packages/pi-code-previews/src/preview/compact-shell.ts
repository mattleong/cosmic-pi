import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Text, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import * as Predicate from "effect/Predicate";
import { invokeHostCallback } from "pi-cosmic-core";
import { composeToolComponent } from "pi-cosmic-ui/tool";
import type { ToolCallBackgroundMode } from "../config/schema";
import { codePreviewSettings } from "../config/state";
import { escapeControlChars } from "../shared/terminal-text";
import { getFallbackResultText } from "../tools/data/results";
import {
  compactStatus,
  resolveCompactSummary,
  type CompactAnimationScheduler,
  type CompactPhase,
  type CompactSummary,
  type CompactSummaryProvider,
} from "../tools/compact-summary";
import type {
  RendererArguments,
  ToolRenderContext as HostToolRenderContext,
} from "../tools/renderers/shared/types";
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
import { timingState, updateToolCallTiming, type ToolCallTiming } from "./tool-timing";
import type { CodePreviewToolShell } from "./tool-shell";
import {
  CompactSlots,
  CompactSlotDrawFailure,
  type CompactRenderBody,
  type CompactSlot,
} from "./compact-slots";

export interface CompactShellOptions {
  name: string;
  // The public adapter retains the tool's argument, details and state types.
  compactSummary: CompactSummaryProvider<any, any, any>;
  scheduleAnimation?: CompactAnimationScheduler | undefined;
  animateProgress?: boolean | undefined;
  showShortTiming?: boolean | undefined;
}

type ToolRenderContext = HostToolRenderContext<any, any>;

interface CompactPlan {
  readonly phase: CompactPhase;
  readonly summary: CompactSummary | undefined;
  readonly collapsedSummary: CompactSummary;
}

/** One mounted call shell owns both slots. The result slot is visible only without that call. */
class CompactShell implements Component {
  private context: ToolRenderContext;
  private theme: Theme;
  private callRender: CompactRenderBody | undefined;
  private resultRender: CompactRenderBody | undefined;
  private contentCallRender: CompactRenderBody | undefined;
  private contentResultRender: CompactRenderBody | undefined;
  private readonly slots = new CompactSlots();
  private result: AgentToolResult<unknown> | undefined;
  private resultPartial: boolean | undefined;
  private callMounted = false;
  private timing: ToolCallTiming | undefined;
  private display: Component | undefined;
  /**
   * TUI frames redraw every row, but the plan's inputs change only in update() and invalidate().
   * Settings replace atomically, so their identity stands in for the policy providers read.
   */
  private planned: { settings: object; plan: CompactPlan } | undefined;
  private collapsed:
    | { plan: CompactPlan; width: number; frame: number | undefined; rows: string[] }
    | undefined;
  private detailBounds: { height: number; width: number } | undefined;
  private readonly mode: ToolCallBackgroundMode;
  private readonly options: CompactShellOptions;
  readonly resultSlot = resultStandIn(this, () => this.callMounted);

  constructor(
    mode: ToolCallBackgroundMode,
    options: CompactShellOptions,
    context: ToolRenderContext,
    theme: Theme,
  ) {
    this.mode = mode;
    this.options = options;
    this.context = context;
    this.theme = theme;
  }

  setCall(
    context: ToolRenderContext,
    theme: Theme,
    render: CompactRenderBody,
    content?: CompactRenderBody,
  ): void {
    this.callMounted = true;
    this.callRender = render;
    this.contentCallRender = content;
    this.update(context, theme);
  }

  setResult(
    context: ToolRenderContext,
    theme: Theme,
    render: CompactRenderBody,
    result: AgentToolResult<unknown>,
    content?: CompactRenderBody,
  ): void {
    this.result = result;
    this.resultPartial = context.isPartial;
    this.resultRender = render;
    this.contentResultRender = content;
    this.update(context, theme);
  }

  private update(context: ToolRenderContext, theme: Theme): void {
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

  private currentResult(): AgentToolResult<unknown> | undefined {
    // Pi calls renderCall before renderResult. A retained streaming result is not a final result.
    return this.resultPartial === this.context.isPartial ? this.result : undefined;
  }

  private plan(result: AgentToolResult<unknown> | undefined): CompactPlan {
    const settings = codePreviewSettings;
    if (this.planned?.settings !== settings)
      this.planned = { settings, plan: this.computePlan(result) };
    return this.planned.plan;
  }

  private computePlan(result: AgentToolResult<unknown> | undefined): CompactPlan {
    const phase = compactPhase(result, this.context);
    const provider = this.options.compactSummary;
    const input = compactPresentationInput(provider, phase, result, this.context);
    const presented = planCompactPresentation(input);
    if (presented.summary) return { phase, ...presented };
    // Only a missing or malformed summary needs a heading, and only the arguments can supply
    // it, so a valid summary is validated once.
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
      // Besides width, only animation ticks change between updates, through shared state.
      const frame = timingState(this.context).codePreviewAnimationFrame;
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
    // Build bodies only when visible. In particular, pending write/edit diffs stay uncomputed.
    this.display ??= this.renderDetails(result !== undefined, plan);
    let rows: string[];
    for (;;) {
      try {
        rows = this.display.render(width);
        break;
      } catch (error) {
        if (!(error instanceof CompactSlotDrawFailure)) throw error;
        // Failed slots now render safe fallback. Recompose ownership without replaying factories.
        this.display = this.renderDetails(result !== undefined, plan, true);
      }
    }
    this.detailBounds = { height: rows.length, width };
    return rows;
  }

  /**
   * Expanded order is fixed: heading, the call's issues with their details, unique call content,
   * then unique result content. Tools without content callbacks keep their original slots, and
   * their issues sit between the original call and result.
   */
  private renderDetails(hasResult: boolean, plan: CompactPlan, reuse = false): Component {
    const { context, theme, timing } = this;
    const { phase, summary } = plan;
    const status = compactStatus(phase, plan.collapsedSummary);
    const border = this.mode === "border";
    const state = borderState(context);
    const content = Boolean(summary && (this.contentCallRender || this.contentResultRender));
    const slot = (name: CompactSlot, original?: CompactRenderBody, unique?: CompactRenderBody) => {
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
      return border ? renderWithBorderSlot(state, name, build) : build();
    };
    // Construction order matches Pi, including callbacks that share producer state.
    const callBody = slot("call", this.callRender, this.contentCallRender);
    const resultBody = hasResult
      ? slot("result", this.resultRender, this.contentResultRender)
      : slot("result");
    const issues = composeToolComponent((width) =>
      renderCompactIssues(summary?.issues, theme, width, true),
    );
    const callSection = new Container();
    if (content && summary) {
      // Border chrome already owns the parent duration.
      const timingEnabled = !border && codePreviewSettings.toolCallTiming;
      callSection.addChild(
        composeToolComponent((width) => [
          renderCompactRow(
            {
              name: this.options.name,
              expanded: true,
              phase,
              summary,
              duration: timing?.duration,
              elapsedMs: timing?.elapsedMs,
              timingEnabled,
              animationFrame: timingState(context).codePreviewAnimationFrame ?? 0,
            },
            theme,
            width,
          ),
        ]),
      );
      callSection.addChild(issues);
    }
    if (callBody) callSection.addChild(callBody);
    const details = new Container();
    if (!content) details.addChild(issues);
    if (resultBody) details.addChild(resultBody);
    if (border) {
      const shell = new BorderedToolCall(theme);
      const color =
        status === "cancelled"
          ? "borderMuted"
          : status === "warning" || status === "uncertain"
            ? "warning"
            : borderColorKey({ isError: status === "error", isPartial: context.isPartial });
      shell.setContent(callSection, details, state, color, timing?.label);
      return shell;
    }
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

  private fallbackSlot(slot: CompactSlot, context: ToolRenderContext): Component {
    if (slot === "result") {
      const color = context.isError ? "error" : "toolOutput";
      return new Text(this.theme.fg(color, escapeControlChars(this.fallbackResultText())), 0, 0);
    }
    // A failed call renderer still leaves the exact input readable, as Pi's own fallback does.
    const lines = [
      this.theme.fg("toolTitle", escapeControlChars(this.options.name)),
      ...fallbackArguments(context.args).map((line) => this.theme.fg("muted", line)),
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
    // Retained bodies must also hear theme invalidation while the compact row hides them.
    this.slots.invalidate();
  }
}

/** Pretty JSON lines, none for empty arguments. JSON escapes C0 controls; this escapes the rest. */
function fallbackArguments(args: RendererArguments): string[] {
  return invokeHostCallback(() => {
    if (args === undefined || args === null) return [];
    if (Predicate.isObject(args) && Object.keys(args).length === 0) return [];
    const json = JSON.stringify(args, null, 2);
    return json === undefined ? [] : escapeControlChars(json).split("\n");
  }, []);
}

export function createCompactToolShell(
  mode: ToolCallBackgroundMode,
  options: CompactShellOptions,
): CodePreviewToolShell {
  const row = rowPerState((context, theme) => new CompactShell(mode, options, context, theme));
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
