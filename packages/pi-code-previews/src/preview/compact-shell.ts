import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import {
  Box,
  Container,
  Text,
  getCapabilities,
  imageFallback,
  type Component,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import type { ToolCallBackgroundMode } from "../config/schema";
import { codePreviewSettings } from "../config/state";
import { escapeControlChars } from "../shared/terminal-text";
import { getTextContent } from "../tools/data/results";
import {
  compactSummaryNeedsDetails,
  resolveCompactSummary,
  type CompactAnimationScheduler,
  type CompactPhase,
  type CompactSummary,
  type CompactSummaryProvider,
} from "../tools/compact-summary";
import type { ToolRenderContext as HostToolRenderContext } from "../tools/renderers/shared/types";
import {
  BorderedToolCall,
  borderState,
  renderWithBorderSlot,
  syncBorderShellChrome,
} from "./bordered-tool-call";
import { renderCompactFailure, renderCompactToolCall } from "./compact-tool-call";
import { compactIssueSeverity, summaryCompactIssues } from "../tools/compact-issues";
import { renderCompactIssues } from "./compact-issues";
import { timingState, updateToolCallTiming, withLastComponent } from "./tool-timing";
import type { CodePreviewToolShell } from "./tool-shell";

export interface CompactShellOptions {
  name: string;
  // The public adapter retains the tool's argument, details and state types.
  compactSummary: CompactSummaryProvider<any, any, any>;
  scheduleAnimation?: CompactAnimationScheduler | undefined;
}

type ToolRenderContext = HostToolRenderContext<any, any>;
type RenderBody = (context: ToolRenderContext) => Component;

/** One mounted call shell owns both slots. The result slot is visible only without that call. */
class CompactShell implements Component {
  private context: ToolRenderContext;
  private theme: Theme;
  private callRender: RenderBody | undefined;
  private resultRender: RenderBody | undefined;
  private callComponent: Component | undefined;
  private resultComponent: Component | undefined;
  private result: AgentToolResult<unknown> | undefined;
  private resultPartial: boolean | undefined;
  private callMounted = false;
  private duration: string | undefined;
  private elapsedMs: number | undefined;
  private timingLabel: string | undefined;
  private display: Component | undefined;
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

  setCall(context: ToolRenderContext, theme: Theme, render: RenderBody): void {
    this.callMounted = true;
    this.callRender = render;
    this.update(context, theme);
  }

  setResult(
    context: ToolRenderContext,
    theme: Theme,
    render: RenderBody,
    result: AgentToolResult<unknown>,
  ): void {
    this.result = result;
    this.resultPartial = context.isPartial;
    this.resultRender = render;
    this.update(context, theme);
  }

  private update(context: ToolRenderContext, theme: Theme): void {
    this.context = context;
    this.theme = theme;
    this.display = undefined;
    this.detailBounds = undefined;
    const timing = updateToolCallTiming(context, {
      animateWithoutTiming: !context.expanded && !context.isError,
      scheduleAnimation: this.options.scheduleAnimation,
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

  private summary(
    phase: CompactPhase,
    result: AgentToolResult<unknown> | undefined,
  ): CompactSummary | undefined {
    try {
      const provider = this.options.compactSummary;
      return resolveCompactSummary(
        provider({
          phase,
          args: this.context.args,
          result,
          context: this.context,
        }),
        phase,
        this.context.isError,
      );
    } catch {
      // An optional summary cannot suppress the tool's original presentation on failure.
      return undefined;
    }
  }

  render(width: number): string[] {
    const result = this.currentResult();
    const phase = this.phase(result);
    const summary = this.summary(phase, result);
    const failure = summary && compactSummaryNeedsDetails(summary);
    const covered =
      !summary ||
      (!summary.issues && !summary.children?.entries.some((child) => child.issues)) ||
      summaryCompactIssues(summary).coverage === "complete";
    if (failure && summary.failure && covered) {
      this.detailBounds = undefined;
      const input = {
        name: this.options.name,
        phase,
        summary,
        failure: summary.failure,
        duration: this.duration,
        elapsedMs: this.elapsedMs,
        timingEnabled: codePreviewSettings.toolCallTiming,
        expanded: this.context.expanded,
      };
      if (!this.context.expanded || this.mode === "off")
        return renderCompactFailure(input, this.theme, width);
      // Expansion retains the selected background/frame, enclosing just one owned view.
      if (!this.display) {
        const body: Component = {
          render: (bodyWidth) => renderCompactFailure(input, this.theme, bodyWidth),
          invalidate: () => undefined,
        };
        if (this.mode === "border") {
          const shell = new BorderedToolCall(this.theme);
          shell.setBorderColor(
            compactIssueSeverity(summaryCompactIssues(summary)) === "error"
              ? "error"
              : summary.outcome === "cancelled"
                ? "borderMuted"
                : summary.outcome === "uncertain"
                  ? "warning"
                  : "error",
          );
          shell.setResult(body);
          this.display = shell;
        } else {
          const background =
            compactIssueSeverity(summaryCompactIssues(summary)) === "error" ||
            summary.outcome === "error"
              ? "toolErrorBg"
              : "toolPendingBg";
          const shell = new Box(1, 1, (text) => this.theme.bg(background, text));
          shell.addChild(body);
          this.display = shell;
        }
      }
      return this.display.render(width);
    }
    if (
      !this.context.expanded &&
      summary &&
      covered &&
      (!failure || summary.detailsOnExpand === true)
    ) {
      this.detailBounds = undefined;
      return renderCompactToolCall(
        {
          name: this.options.name,
          phase,
          summary,
          duration: this.duration,
          elapsedMs: this.elapsedMs,
          timingEnabled: codePreviewSettings.toolCallTiming,
          animationFrame: timingState(this.context).codePreviewAnimationFrame,
        },
        this.theme,
        width,
      );
    }
    // Build bodies only when visible. In particular, pending write/edit diffs stay uncomputed.
    this.display ??= this.renderDetails(result !== undefined, summary);
    let rows: string[];
    try {
      rows = this.display.render(width);
    } catch {
      // Ownership is accepted only after rendering succeeds, not merely construction.
      // Never replay a hostile renderer to recover its output.
      this.callComponent = undefined;
      this.resultComponent = undefined;
      this.display = this.renderDetails(result !== undefined, summary, true);
      rows = this.display.render(width);
    }
    this.detailBounds = { offset: 0, height: rows.length, width };
    return rows;
  }

  private renderDetails(
    hasResult: boolean,
    summary: CompactSummary | undefined,
    fallback = false,
  ): Component {
    const outcome = summary?.outcome;
    const context = this.context;
    const isError =
      (summary !== undefined && compactIssueSeverity(summaryCompactIssues(summary)) === "error") ||
      (outcome !== "cancelled" &&
        outcome !== "uncertain" &&
        (context.isError || outcome === "error"));
    const state = borderState(context);
    const callContext = withLastComponent(context, this.callComponent);
    const resultContext = withLastComponent(context, this.resultComponent);
    const call = this.callRender;
    const result = this.resultRender;
    const renderCall = () =>
      call
        ? fallback
          ? this.fallbackSlot("call", callContext)
          : this.renderSlot("call", call, callContext)
        : undefined;
    const renderResult = () =>
      hasResult && result
        ? fallback
          ? this.fallbackSlot("result", resultContext)
          : this.renderSlot("result", result, resultContext)
        : undefined;
    const callBody =
      this.mode === "border" ? renderWithBorderSlot(state, "call", renderCall) : renderCall();
    const resultBody =
      this.mode === "border" ? renderWithBorderSlot(state, "result", renderResult) : renderResult();
    // Only a current successful original result can accept shared presentation ownership.
    const resultOwns =
      !fallback &&
      (!summary ||
        (!summary.issues && !summary.children?.entries.some((child) => child.issues)) ||
        summaryCompactIssues(summary).coverage === "complete") &&
      context.expanded &&
      resultBody !== undefined &&
      resultBody === this.resultComponent;
    const issues = summary
      ? summaryCompactIssues(summary, context.expanded)
      : { coverage: "unknown" as const, entries: [] };
    const visibleIssues = {
      ...issues,
      entries: issues.entries.filter((issue) => !resultOwns || !issue.expandedInResult),
    };
    const noticeBody: Component = {
      render: (width) =>
        renderCompactIssues(
          visibleIssues,
          this.theme,
          width,
          context.expanded,
          Boolean(summary?.children?.total),
          isError,
        ),
      invalidate: () => undefined,
    };
    const details = new Container();
    if (resultBody) details.addChild(resultBody);
    details.addChild(noticeBody);
    const visibleCall = resultOwns && summary?.expandedResultOwnsCall ? undefined : callBody;
    if (this.mode === "border") {
      const shell = new BorderedToolCall(this.theme);
      syncBorderShellChrome(shell, state, { ...context, isError }, this.timingLabel);
      if (!isError && outcome === "cancelled") shell.setBorderColor("borderMuted");
      else if (!isError && outcome === "uncertain") shell.setBorderColor("warning");
      shell.setCall(visibleCall);
      shell.setResult(details);
      return shell;
    }
    const background = isError
      ? "toolErrorBg"
      : context.isPartial || outcome === "cancelled" || outcome === "uncertain"
        ? "toolPendingBg"
        : "toolSuccessBg";
    const shell =
      this.mode === "on"
        ? new Box(1, 1, (text) => this.theme.bg(background, text))
        : new Container();
    if (visibleCall) shell.addChild(visibleCall);
    shell.addChild(details);
    if (this.timingLabel)
      shell.addChild(new Text(this.theme.fg("muted", `╰─ ${this.timingLabel}`), 0, 0));
    return shell;
  }

  private renderSlot(
    slot: "call" | "result",
    render: RenderBody,
    context: ToolRenderContext,
  ): Component {
    try {
      const component = render(context);
      if (slot === "call") this.callComponent = component;
      else this.resultComponent = component;
      return component;
    } catch {
      // Pi clears a failed slot. Never return fallback Text as a custom renderer's lastComponent.
      if (slot === "call") this.callComponent = undefined;
      else this.resultComponent = undefined;
      return this.fallbackSlot(slot, context);
    }
  }

  private fallbackSlot(slot: "call" | "result", context: ToolRenderContext): Component {
    const text = slot === "call" ? this.options.name : this.fallbackResultText();
    const color = slot === "call" ? "toolTitle" : context.isError ? "error" : "toolOutput";
    return new Text(this.theme.fg(color, escapeControlChars(text)), 0, 0);
  }

  private fallbackResultText(): string {
    const content = this.currentResult()?.content ?? [];
    const text = getTextContent(content);
    if (this.context.showImages && getCapabilities().images) return text;
    const images = content.flatMap((part) =>
      part.type === "image" ? [imageFallback(part.mimeType)] : [],
    );
    return [text, ...images].filter(Boolean).join("\n");
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
    this.callComponent?.invalidate();
    this.resultComponent?.invalidate();
    this.display = undefined;
  }
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
    renderCall(context, theme, render) {
      const shell = row(context, theme);
      shell.setCall(context, theme, render);
      return shell;
    },
    renderResult(context, theme, render, result) {
      // The adapter supplies results. Direct shell consumers without one keep their body.
      if (!result) return render(context);
      const shell = row(context, theme);
      shell.setResult(context, theme, render, result);
      return shell.resultSlot;
    },
  };
}
