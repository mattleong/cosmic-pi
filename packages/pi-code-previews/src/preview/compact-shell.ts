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
import { renderExpandedAttention } from "./compact-issues";
import { renderCompactRow } from "./compact-row";
import { planCompactPresentation } from "../tools/compact-presentation";
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
  private contentCallRender: RenderBody | undefined;
  private contentResultRender: RenderBody | undefined;
  private contentCallComponent: Component | undefined;
  private contentResultComponent: Component | undefined;
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
    argumentOnly = false,
  ): CompactSummary | undefined {
    try {
      const provider = this.options.compactSummary;
      return resolveCompactSummary(
        provider({
          phase,
          args: this.context.args,
          result,
          context: argumentOnly
            ? { ...this.context, isError: false, isPartial: true }
            : this.context,
        }),
        phase,
        argumentOnly ? false : this.context.isError,
      );
    } catch {
      // A broken projector loses semantic ownership, not the user's compact preference.
      return undefined;
    }
  }

  render(width: number): string[] {
    const result = this.currentResult();
    const phase = this.phase(result);
    const summary = this.summary(phase, result);
    const plan = planCompactPresentation({
      summary,
      phase,
      isError: this.context.isError,
      expanded: this.context.expanded,
      heading: summary ?? this.summary("pending", undefined, true),
    });
    if (
      plan.useFailure &&
      summary?.failure &&
      !(this.context.expanded && (this.contentCallRender || this.contentResultRender))
    ) {
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
    if (!this.context.expanded) {
      this.detailBounds = undefined;
      return renderCompactToolCall(
        {
          name: this.options.name,
          phase,
          summary: plan.collapsedSummary,
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
      this.contentCallComponent = undefined;
      this.contentResultComponent = undefined;
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
    const plan = planCompactPresentation({
      summary,
      phase: this.phase(this.currentResult()),
      isError: context.isError,
      expanded: context.expanded,
    });
    const content =
      !fallback &&
      plan.useExpandedContent &&
      Boolean(this.contentCallRender || this.contentResultRender);
    const contentCall = content && Boolean(this.contentCallRender);
    const contentResult = content && Boolean(this.contentResultRender);
    const callContext = withLastComponent(
      context,
      contentCall ? this.contentCallComponent : this.callComponent,
    );
    const resultContext = withLastComponent(
      context,
      contentResult ? this.contentResultComponent : this.resultComponent,
    );
    const call = contentCall ? this.contentCallRender : this.callRender;
    const ownedFailure = content && plan.useFailure ? summary?.failure : undefined;
    const result = contentResult ? this.contentResultRender : this.resultRender;
    const renderCall = () =>
      call
        ? fallback
          ? this.fallbackSlot("call", callContext)
          : this.renderSlot("call", call, callContext, contentCall)
        : undefined;
    const renderResult = () =>
      ownedFailure
        ? new Text(
            this.theme.fg(isError ? "error" : "warning", escapeControlChars(ownedFailure.details)),
            0,
            0,
          )
        : hasResult && result
          ? fallback
            ? this.fallbackSlot("result", resultContext)
            : this.renderSlot("result", result, resultContext, contentResult)
          : undefined;
    const callBody =
      this.mode === "border" ? renderWithBorderSlot(state, "call", renderCall) : renderCall();
    const resultBody =
      this.mode === "border" ? renderWithBorderSlot(state, "result", renderResult) : renderResult();
    // Only a current successful original result can accept shared presentation ownership.
    const resultRendered =
      !fallback &&
      context.expanded &&
      resultBody !== undefined &&
      (Boolean(ownedFailure) ||
        resultBody === (contentResult ? this.contentResultComponent : this.resultComponent));
    // Each marked issue has its own ownership promise. Unknown aggregate coverage
    // still forbids taking over the whole call or replacing its original result.
    const resultOwns =
      resultRendered &&
      (!summary ||
        (!summary.issues && !summary.children?.entries.some((child) => child.issues)) ||
        summaryCompactIssues(summary).coverage === "complete");
    const issues = summary
      ? summaryCompactIssues(summary, context.expanded)
      : { coverage: "unknown" as const, entries: [] };
    const noticeBody: Component = {
      render: (width) =>
        renderExpandedAttention(
          issues,
          resultRendered
            ? ownedFailure
              ? ownedFailure.ownedIssues
              : summary?.expandedResultOwnsIssues
            : undefined,
          this.theme,
          width,
        ),
      invalidate: () => undefined,
    };
    const details = new Container();
    if (resultBody) details.addChild(resultBody);
    details.addChild(noticeBody);
    const visibleCall =
      !content && resultOwns && summary?.expandedResultOwnsCall ? undefined : callBody;
    const heading: Component | undefined =
      content && summary
        ? {
            render: (width) => [
              renderCompactRow(
                {
                  name: this.options.name,
                  phase: this.phase(this.currentResult()),
                  summary,
                  duration: this.duration,
                  elapsedMs: this.elapsedMs,
                  // Border chrome already owns the parent duration.
                  timingEnabled: this.mode !== "border" && codePreviewSettings.toolCallTiming,
                },
                this.theme,
                width,
              ),
            ],
            invalidate: () => undefined,
          }
        : undefined;
    const callSection = new Container();
    if (heading) callSection.addChild(heading);
    if (visibleCall) callSection.addChild(visibleCall);
    if (this.mode === "border") {
      const shell = new BorderedToolCall(this.theme);
      syncBorderShellChrome(shell, state, { ...context, isError }, this.timingLabel);
      if (!isError && outcome === "cancelled") shell.setBorderColor("borderMuted");
      else if (!isError && outcome === "uncertain") shell.setBorderColor("warning");
      shell.setCall(callSection);
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
    shell.addChild(callSection);
    shell.addChild(details);
    if (this.timingLabel && !content)
      shell.addChild(new Text(this.theme.fg("muted", `╰─ ${this.timingLabel}`), 0, 0));
    return shell;
  }

  private renderSlot(
    slot: "call" | "result",
    render: RenderBody,
    context: ToolRenderContext,
    content: boolean,
  ): Component {
    try {
      const component = render(context);
      if (content) {
        if (slot === "call") this.contentCallComponent = component;
        else this.contentResultComponent = component;
      } else if (slot === "call") this.callComponent = component;
      else this.resultComponent = component;
      return component;
    } catch {
      // Pi clears a failed slot. Never return fallback Text as a custom renderer's lastComponent.
      if (content) {
        if (slot === "call") this.contentCallComponent = undefined;
        else this.contentResultComponent = undefined;
      } else if (slot === "call") this.callComponent = undefined;
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
    this.contentCallComponent?.invalidate();
    this.contentResultComponent?.invalidate();
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
