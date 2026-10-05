import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Text, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import * as Predicate from "effect/Predicate";
import { invokeHostCallback } from "pi-cosmic-core";
import type { ToolCallBackgroundMode } from "../config/schema";
import { codePreviewSettings } from "../config/state";
import { escapeControlChars } from "../shared/terminal-text";
import { getFallbackResultText, getTextContent } from "../tools/data/results";
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
  borderState,
  renderWithBorderSlot,
  syncBorderShellChrome,
} from "./bordered-tool-call";
import { renderCompactToolCall } from "./compact-tool-call";
import { planCompactPresentation } from "../tools/compact-presentation";
import { timingState, updateToolCallTiming } from "./tool-timing";
import type { CodePreviewToolShell } from "./tool-shell";
import { composeCompactDetails } from "./compact-details";
import { CompactSlots, CompactSlotDrawFailure } from "./compact-slots";

export interface CompactShellOptions {
  name: string;
  // The public adapter retains the tool's argument, details and state types.
  compactSummary: CompactSummaryProvider<any, any, any>;
  scheduleAnimation?: CompactAnimationScheduler | undefined;
  animateProgress?: boolean | undefined;
  showShortTiming?: boolean | undefined;
}

type ToolRenderContext = HostToolRenderContext<any, any>;
type RenderBody = (context: ToolRenderContext) => Component;

interface CompactPlan {
  readonly phase: CompactPhase;
  readonly summary: CompactSummary | undefined;
  readonly collapsedSummary: CompactSummary;
}

/** One mounted call shell owns both slots. The result slot is visible only without that call. */
class CompactShell implements Component {
  private context: ToolRenderContext;
  private theme: Theme;
  private callRender: RenderBody | undefined;
  private resultRender: RenderBody | undefined;
  private contentCallRender: RenderBody | undefined;
  private contentResultRender: RenderBody | undefined;
  private readonly slots = new CompactSlots();
  private result: AgentToolResult<unknown> | undefined;
  private resultPartial: boolean | undefined;
  private callMounted = false;
  private duration: string | undefined;
  private elapsedMs: number | undefined;
  private timingLabel: string | undefined;
  private display: Component | undefined;
  /**
   * TUI frames redraw every row, but the plan's inputs change only in update() and invalidate().
   * Settings replace atomically, so their identity stands in for the policy providers read.
   */
  private planned: { settings: object; plan: CompactPlan } | undefined;
  private collapsed:
    | { plan: CompactPlan; width: number; frame: number | undefined; rows: string[] }
    | undefined;
  private detailBounds: { offset: number; height: number; width: number } | undefined;
  private readonly mode: ToolCallBackgroundMode;
  private readonly options: CompactShellOptions;
  readonly resultSlot: Component;

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
    this.resultSlot = {
      render: (width) => (this.callMounted ? [] : this.render(width)),
      handleMouse: (event) => (this.callMounted ? undefined : this.handleMouse(event)),
      invalidate: () => {
        if (!this.callMounted) this.invalidate();
      },
    };
  }

  setCall(
    context: ToolRenderContext,
    theme: Theme,
    render: RenderBody,
    content?: RenderBody,
  ): void {
    this.callMounted = true;
    this.callRender = render;
    this.contentCallRender = content;
    this.update(context, theme);
  }

  setResult(
    context: ToolRenderContext,
    theme: Theme,
    render: RenderBody,
    result: AgentToolResult<unknown>,
    content?: RenderBody,
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
    this.display = undefined;
    this.planned = undefined;
    this.collapsed = undefined;
    this.detailBounds = undefined;
    const timing = updateToolCallTiming(context, {
      animateWithoutTiming:
        (!context.expanded || this.options.animateProgress === true) && !context.isError,
      scheduleAnimation: this.options.scheduleAnimation,
      showShortTiming: this.options.showShortTiming,
    });
    this.duration = timing?.duration;
    this.elapsedMs = timing?.elapsedMs;
    this.timingLabel = timing?.label;
  }

  private currentResult(): AgentToolResult<unknown> | undefined {
    // Pi calls renderCall before renderResult. A retained streaming result is not a final result.
    return this.resultPartial === this.context.isPartial ? this.result : undefined;
  }

  private phase(result: AgentToolResult<unknown> | undefined): CompactPhase {
    if (result && !this.context.isPartial) return "settled";
    return this.context.executionStarted ? "running" : "pending";
  }

  /** Raw provider output. A broken projector loses semantic ownership, not compact mode. */
  private provide(
    phase: CompactPhase,
    result: AgentToolResult<unknown> | undefined,
    argumentOnly = false,
  ): CompactSummary | undefined {
    try {
      return this.options.compactSummary({
        phase,
        args: this.context.args,
        result,
        context: argumentOnly ? { ...this.context, isError: false, isPartial: true } : this.context,
      });
    } catch {
      return undefined;
    }
  }

  private plan(result: AgentToolResult<unknown> | undefined): CompactPlan {
    const settings = codePreviewSettings;
    if (this.planned?.settings !== settings)
      this.planned = { settings, plan: this.computePlan(result) };
    return this.planned.plan;
  }

  private computePlan(result: AgentToolResult<unknown> | undefined): CompactPlan {
    const phase = this.phase(result);
    const input = {
      summary: this.provide(phase, result),
      phase,
      isError: this.context.isError,
      errorText: this.context.isError ? getTextContent(result?.content ?? []) : "",
    };
    const presented = planCompactPresentation(input);
    if (presented.summary) return { phase, ...presented };
    // Only a missing or malformed summary needs a heading, and only the arguments can supply
    // it, so a valid summary is validated once.
    const heading = resolveCompactSummary(
      this.provide("pending", undefined, true),
      "pending",
      false,
    );
    return { phase, ...planCompactPresentation({ ...input, summary: undefined, heading }) };
  }

  render(width: number): string[] {
    const result = this.currentResult();
    const plan = this.plan(result);
    const { phase, summary, collapsedSummary } = plan;
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
          phase,
          summary: collapsedSummary,
          duration: this.duration,
          elapsedMs: this.elapsedMs,
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
    this.display ??= this.renderDetails(result !== undefined, phase, summary, collapsedSummary);
    let rows: string[];
    for (;;) {
      try {
        rows = this.display.render(width);
        break;
      } catch (error) {
        if (!(error instanceof CompactSlotDrawFailure)) throw error;
        // Failed slots now render safe fallback. Recompose ownership without replaying factories.
        this.display = this.renderDetails(
          result !== undefined,
          phase,
          summary,
          collapsedSummary,
          true,
        );
      }
    }
    this.detailBounds = { offset: 0, height: rows.length, width };
    return rows;
  }

  private renderDetails(
    hasResult: boolean,
    phase: CompactPhase,
    summary: CompactSummary | undefined,
    collapsed: CompactSummary,
    reuse = false,
  ): Component {
    const context = this.context;
    const status = compactStatus(phase, collapsed);
    const isError = status === "error";
    const state = borderState(context);
    const { callSection, details, content } = composeCompactDetails({
      name: this.options.name,
      context,
      theme: this.theme,
      summary,
      phase,
      hasResult,
      slots: this.slots,
      call: this.callRender,
      result: this.resultRender,
      contentCall: this.contentCallRender,
      contentResult: this.contentResultRender,
      reuse,
      fallback: (slot) => this.fallbackSlot(slot, context),
      construct: (slot, body) =>
        this.mode === "border" ? renderWithBorderSlot(state, slot, body) : body(),
      duration: this.duration,
      elapsedMs: this.elapsedMs,
      // Border chrome already owns the parent duration.
      timingEnabled: this.mode !== "border" && codePreviewSettings.toolCallTiming,
    });
    if (this.mode === "border") {
      const shell = new BorderedToolCall(this.theme);
      syncBorderShellChrome(shell, state, { ...context, isError }, this.timingLabel);
      if (status === "cancelled") shell.setBorderColor("borderMuted");
      else if (status === "warning" || status === "uncertain") shell.setBorderColor("warning");
      shell.setCall(callSection);
      shell.setResult(details);
      return shell;
    }
    const background = isError
      ? "toolErrorBg"
      : context.isPartial || status === "cancelled" || status === "uncertain"
        ? "toolPendingBg"
        : "toolSuccessBg";
    const shell =
      this.mode === "on"
        ? new Box(1, 1, (text) => this.theme.bg(background, text))
        : new Container();
    shell.addChild(callSection);
    shell.addChild(details);
    if (this.timingLabel && !content)
      shell.addChild(new Text(this.theme.fg("muted", `╰─ ${this.timingLabel}`), 0, 0));
    return shell;
  }

  private fallbackSlot(slot: "call" | "result", context: ToolRenderContext): Component {
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
    const y = event.y - bounds.offset;
    if (y < 0 || y >= bounds.height) return undefined;
    return this.display.handleMouse?.({ ...event, y, height: bounds.height });
  }

  invalidate(): void {
    this.detailBounds = undefined;
    // Retained bodies must also hear theme invalidation while the compact row hides them.
    this.slots.invalidate();
    this.display = undefined;
    this.planned = undefined;
    this.collapsed = undefined;
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
  const rows = new WeakMap<object, CompactShell>();
  const row = (context: ToolRenderContext, theme: Theme): CompactShell => {
    const current = rows.get(context.state);
    if (current) return current;
    const shell = new CompactShell(mode, options, context, theme);
    rows.set(context.state, shell);
    return shell;
  };
  return {
    renderShell: "self",
    renderCall(context, theme, render, content) {
      const shell = row(context, theme);
      shell.setCall(context, theme, render, content);
      return shell;
    },
    renderResult(context, theme, render, result, content) {
      // The adapter supplies results. Direct shell consumers without one keep their body.
      if (!result) return render(context);
      const shell = row(context, theme);
      shell.setResult(context, theme, render, result, content);
      return shell.resultSlot;
    },
  };
}
