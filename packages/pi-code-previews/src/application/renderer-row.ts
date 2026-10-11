import type {
  AgentToolResult,
  Theme,
  ToolRenderers,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { invokeHostCallback } from "pi-cosmic-core";
import { rowPerState, withSelfBackground } from "../preview/self-background";
import { fallbackArguments } from "../tools/data/args";
import { getFallbackResultText } from "../tools/data/results";
import { escapeControlChars } from "../shared/terminal-text";
import type { RendererState, ToolRenderContext } from "../tools/renderers/shared/types";

export function rendererFields(renderers: ToolRenderers | undefined): ToolRenderers | undefined {
  if (!renderers) return undefined;
  return {
    ...(renderers.renderShell && { renderShell: renderers.renderShell }),
    ...(renderers.renderCall && { renderCall: renderers.renderCall }),
    ...(renderers.renderResult && { renderResult: renderers.renderResult }),
  };
}

export class RetainedRendererGate {
  live = true;
  ready = false;
  private readonly refreshers = new Set<() => void>();

  subscribe(refresh: () => void): void {
    if (this.live && !this.ready) this.refreshers.add(refresh);
  }

  markReady(): void {
    this.ready = true;
    for (const refresh of this.refreshers) invokeHostCallback(refresh, undefined);
    this.refreshers.clear();
  }

  retire(): void {
    this.live = false;
    this.refreshers.clear();
  }
}
type RetainedRendererOwner = Readonly<Pick<RetainedRendererGate, "live" | "ready" | "subscribe">>;

function nativeBackground(name: string, downstream: ToolRenderers | undefined): ToolRenderers {
  const call: NonNullable<ToolRenderers["renderCall"]> =
    downstream?.renderCall ??
    ((args, theme) =>
      new Text(
        [theme.fg("toolTitle", theme.bold(name)), ...fallbackArguments(args)].join("\n"),
        0,
        0,
      ));
  const result: NonNullable<ToolRenderers["renderResult"]> =
    downstream?.renderResult ??
    ((value, _options, theme, context) => {
      const output = getFallbackResultText(value.content, context.showImages);
      return output
        ? new Text(theme.fg("toolOutput", escapeControlChars(output)), 0, 0)
        : new Container();
    });
  if (downstream?.renderShell === "self")
    return { renderShell: "self", renderCall: call, renderResult: result };
  const shell = withSelfBackground({
    renderShell: "default",
    renderCall: (context, _theme, render) => render(context),
    renderResult: (context, _theme, render) => render(context),
  });
  return {
    renderShell: "self",
    renderCall: (args, theme, context) =>
      shell.renderCall(context, theme, (current) => call(args, theme, current)),
    renderResult: (value, options, theme, context) =>
      shell.renderResult(
        context,
        theme,
        (current) => result(value, options, theme, current),
        value,
      ),
  };
}

type RowContext = ToolRenderContext<RendererState, unknown>;

class RetainedRendererRow {
  private renderers: ToolRenderers;
  private adopted = false;
  private state: RendererState | undefined;
  private call: Component | undefined;
  private result: Component | undefined;
  private args: unknown;
  private theme: Theme | undefined;
  private context: RowContext | undefined;
  private value: AgentToolResult<unknown> | undefined;
  private options: ToolRenderResultOptions | undefined;
  private readonly stale = { call: true, result: true };

  readonly callSlot = this.slot("call");
  readonly resultSlot = this.slot("result");

  private readonly owner: RetainedRendererOwner;
  private readonly select: () => ToolRenderers | undefined;

  constructor(
    owner: RetainedRendererOwner,
    fallback: ToolRenderers,
    select: () => ToolRenderers | undefined,
  ) {
    this.owner = owner;
    this.select = select;
    this.renderers = fallback;
    owner.subscribe(() => {
      try {
        this.refresh();
      } finally {
        this.context?.invalidate();
      }
    });
  }

  updateCall<Args>(args: Args, theme: Theme, context: RowContext): Component {
    this.args = args;
    this.theme = theme;
    this.context = context;
    this.stale.call = true;
    this.refresh("call");
    return this.callSlot;
  }

  updateResult(
    value: AgentToolResult<unknown>,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: RowContext,
  ): Component {
    this.args = context.args;
    this.value = value;
    this.options = options;
    this.theme = theme;
    this.context = context;
    this.stale.result = true;
    this.refresh();
    return this.resultSlot;
  }

  private refresh(through: "call" | "result" = "result"): void {
    if (!this.context || !this.theme) return;
    this.state ??= { ...this.context.state };
    if (!this.adopted && this.owner.ready && this.owner.live) {
      this.adopted = true;
      const selected = this.select();
      if (selected) {
        this.renderers = selected;
        this.state = { ...this.context.state };
        this.call = undefined;
        this.result = undefined;
      }
      this.stale.call = true;
      this.stale.result = true;
    }
    const context = { ...this.context, state: this.state };
    const call = this.renderers.renderCall;
    const result = this.renderers.renderResult;
    if (this.stale.call) {
      this.stale.call = false;
      if (call) this.call = call(this.args, this.theme, { ...context, lastComponent: this.call });
    }
    if (through === "call" || !this.stale.result) return;
    this.stale.result = false;
    if (result && this.value && this.options)
      this.result = result(
        this.value,
        { ...this.options, expanded: context.expanded, isPartial: context.isPartial },
        this.theme,
        { ...context, lastComponent: this.result },
      );
  }

  private slot(slot: "call" | "result"): Component {
    return {
      render: (width) => {
        this.refresh();
        return this[slot]?.render(width) ?? [];
      },
      handleMouse: (event: TuiMouseEvent) => {
        this.refresh();
        return this[slot]?.handleMouse?.(event);
      },
      invalidate: () => {
        this[slot]?.invalidate();
        this.stale[slot] = true;
      },
    };
  }
}

export function retainedCodePreviewRenderers(
  name: string,
  downstream: ToolRenderers | undefined,
  owner: RetainedRendererOwner,
  select: () => ToolRenderers | undefined,
): ToolRenderers {
  const fallback = nativeBackground(name, downstream);
  const row = rowPerState(() => new RetainedRendererRow(owner, fallback, select));
  return {
    renderShell: "self",
    renderCall: (args, theme, context) => row(context, theme).updateCall(args, theme, context),
    renderResult: (value, options, theme, context) =>
      row(context, theme).updateResult(value, options, theme, context),
  };
}
