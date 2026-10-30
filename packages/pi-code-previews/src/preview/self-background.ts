import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ToolRenderContext } from "../tools/renderers/shared/types";
import { Box, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { CompactStatus } from "../tools/compact-summary";
import type { CodePreviewToolShell } from "./tool-shell";

/** Pi's tool-row background for a row's strongest status. */
export function statusBackground(
  status: CompactStatus,
  isPartial: boolean,
): "toolErrorBg" | "toolPendingBg" | "toolSuccessBg" {
  if (status === "error") return "toolErrorBg";
  return isPartial || status === "cancelled" || status === "uncertain" || status === "attention"
    ? "toolPendingBg"
    : "toolSuccessBg";
}

export function rowPerState<TArgs, TState extends object, Row>(
  create: (context: ToolRenderContext<TState, TArgs>, theme: Theme) => Row,
) {
  const rows = new WeakMap<object, Row>();
  return (context: ToolRenderContext<TState, TArgs>, theme: Theme): Row => {
    const current = rows.get(context.state);
    if (current) return current;
    const row = create(context, theme);
    rows.set(context.state, row);
    return row;
  };
}

export const resultStandIn = (row: Component, callMounted: () => boolean): Component => ({
  render: (width) => (callMounted() ? [] : row.render(width)),
  handleMouse: (event) => (callMounted() ? undefined : row.handleMouse?.(event)),
  invalidate: () => {
    if (!callMounted()) row.invalidate();
  },
});

class SelfBackgroundRow<TArgs, TState> implements Component {
  private readonly box: Box;
  private call: Component | undefined;
  private result: Component | undefined;
  readonly resultSlot = resultStandIn(this, () => this.call !== undefined);

  private context: ToolRenderContext<TState, TArgs>;
  private theme: Theme;

  constructor(context: ToolRenderContext<TState, TArgs>, theme: Theme) {
    this.context = context;
    this.theme = theme;
    this.box = new Box(1, 1, (text) =>
      this.theme.bg(
        this.context.isPartial
          ? "toolPendingBg"
          : this.context.isError
            ? "toolErrorBg"
            : "toolSuccessBg",
        text,
      ),
    );
  }

  set(
    slot: "call" | "result",
    component: Component,
    context: ToolRenderContext<TState, TArgs>,
    theme: Theme,
  ) {
    if (slot === "call") this.call = component;
    else this.result = component;
    this.context = context;
    this.theme = theme;
    this.box.clear();
    if (this.call) this.box.addChild(this.call);
    if (this.result) this.box.addChild(this.result);
  }

  content(slot: "call" | "result"): Component | undefined {
    return this[slot];
  }

  render(width: number): string[] {
    return this.box.render(width);
  }

  handleMouse(event: TuiMouseEvent) {
    return this.box.handleMouse(event);
  }

  invalidate(): void {
    this.box.invalidate();
  }
}

export function withSelfBackground<TArgs, TDetails, TState extends object>(
  shell: CodePreviewToolShell<TArgs, TDetails, TState>,
): CodePreviewToolShell<TArgs, TDetails, TState> {
  const row = rowPerState<TArgs, TState, SelfBackgroundRow<TArgs, TState>>(
    (context, theme) => new SelfBackgroundRow(context, theme),
  );
  return {
    renderShell: "self",
    renderCall(context, theme, render, content) {
      const current = row(context, theme);
      const innerContext = { ...context, lastComponent: current.content("call") };
      current.set("call", shell.renderCall(innerContext, theme, render, content), context, theme);
      return current;
    },
    renderResult(context, theme, render, result, content) {
      const current = row(context, theme);
      current.set(
        "result",
        shell.renderResult(
          { ...context, lastComponent: current.content("result") },
          theme,
          render,
          result,
          content,
        ),
        context,
        theme,
      );
      return current.resultSlot;
    },
  };
}
