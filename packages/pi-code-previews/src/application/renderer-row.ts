import type {
  AgentToolResult,
  Theme,
  ToolRenderers,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { invokeHostCallback } from "pi-cosmic-core";
import { rowPerState, withSelfBackground } from "../preview/self-background";
import { getFallbackResultText } from "../tools/data/results";
import { escapeControlChars } from "../shared/terminal-text";
import type { RendererArguments, ToolRenderContext } from "../tools/renderers/shared/types";

/** Keep only Pi's public presentation fields, never an execution definition. */
export function rendererFields(renderers: ToolRenderers | undefined): ToolRenderers | undefined {
  if (!renderers) return undefined;
  return {
    ...(renderers.renderShell && { renderShell: renderers.renderShell }),
    ...(renderers.renderCall && { renderCall: renderers.renderCall }),
    ...(renderers.renderResult && { renderResult: renderers.renderResult }),
  };
}

/** An owner's one-way readiness: rows retained before startup refresh once when it publishes. */
export class RetainedRendererGate {
  live = true;
  ready = false;
  private readonly refreshers = new Set<() => void>();

  subscribe(refresh: () => void): void {
    if (this.live && !this.ready) this.refreshers.add(refresh);
  }

  /** Publish the owner's state first; each retained row then adopts it. */
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
/** Rows observe readiness; only the owner publishes or retires it. */
type RetainedRendererOwner = Readonly<Pick<RetainedRendererGate, "live" | "ready" | "subscribe">>;

/** Cold rows preserve downstream content with the same framing Pi would otherwise provide. */
function nativeBackground(name: string, downstream: ToolRenderers | undefined): ToolRenderers {
  const call: NonNullable<ToolRenderers["renderCall"]> =
    downstream?.renderCall ??
    ((args, theme) =>
      new Text(
        `${theme.fg("toolTitle", theme.bold(name))}\n${JSON.stringify(args, null, 2)}`,
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
  const state = rowPerState<{ call?: Component; result?: Component }>(() => ({}));
  const shell = withSelfBackground({
    renderShell: "default",
    renderCall: (context, _theme, render) => render(context),
    renderResult: (context, _theme, render) => render(context),
  });
  return {
    renderShell: "self",
    renderCall: (args, theme, context) =>
      shell.renderCall(context, theme, (current) => {
        const cache = state(current, theme);
        cache.call = call(args, theme, { ...current, lastComponent: cache.call });
        return cache.call;
      }),
    renderResult: (value, options, theme, context) =>
      shell.renderResult(
        context,
        theme,
        (current) => {
          const cache = state(current, theme);
          cache.result = result(value, options, theme, { ...current, lastComponent: cache.result });
          return cache.result;
        },
        value,
      ),
  };
}

class RetainedRendererRow {
  private renderers: ToolRenderers;
  private adopted = false;
  private state: ToolRenderContext["state"];
  private call: Component | undefined;
  private result: Component | undefined;
  private args: RendererArguments;
  private theme: Theme | undefined;
  private context: ToolRenderContext | undefined;
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
      // Capture this owner's first-ready shell even if the host defers its next draw.
      try {
        this.refresh();
      } finally {
        this.context?.invalidate();
      }
    });
  }

  updateCall(args: RendererArguments, theme: Theme, context: ToolRenderContext): Component {
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
    context: ToolRenderContext,
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

  /** Pi draws the call, then the result, so a call update need not rebuild retained output. */
  private refresh(through: "call" | "result" = "result"): void {
    if (!this.context || !this.theme) return;
    this.state ??= { ...this.context.state };
    if (!this.adopted && this.owner.ready && this.owner.live) {
      this.adopted = true;
      const selected = this.select();
      if (selected) {
        this.renderers = selected;
        // New internal slots don't inherit downstream caches; preserve public initial state.
        this.state = { ...this.context.state };
        this.call = undefined;
        this.result = undefined;
      }
      // Adoption rebuilds call first, then refeeds retained output: combined shells own both.
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

/** Pi retains this facade once, including renderShell, before session_start during replay. */
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
