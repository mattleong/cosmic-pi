import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { ToolRenderContext } from "../tools/renderers/shared/types";
import type { CodePreviewToolShell } from "./tool-shell";

/** One self-shell row per tool call: Pi shares renderer state between its call and result slots. */
export function rowPerState<Row>(create: (context: ToolRenderContext, theme: Theme) => Row) {
  const rows = new WeakMap<object, Row>();
  return (context: ToolRenderContext, theme: Theme): Row => {
    const current = rows.get(context.state);
    if (current) return current;
    const row = create(context, theme);
    rows.set(context.state, row);
    return row;
  };
}

/** The result slot shows its row only while no call slot has mounted that row. */
export const resultStandIn = (row: Component, callMounted: () => boolean): Component => ({
  render: (width) => (callMounted() ? [] : row.render(width)),
  handleMouse: (event) => (callMounted() ? undefined : row.handleMouse?.(event)),
  invalidate: () => {
    if (!callMounted()) row.invalidate();
  },
});

/** A fixed self shell can adopt settings after Pi has retained a replayed row. */
class SelfBackgroundRow implements Component {
  private readonly box: Box;
  private call: Component | undefined;
  private result: Component | undefined;
  readonly resultSlot = resultStandIn(this, () => this.call !== undefined);

  private context: ToolRenderContext;
  private theme: Theme;

  constructor(context: ToolRenderContext, theme: Theme) {
    this.context = context;
    this.theme = theme;
    this.box = new Box(1, 1, (text) =>
      // Pi's own box stays pending until the call settles, even for an error update.
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

  set(slot: "call" | "result", component: Component, context: ToolRenderContext, theme: Theme) {
    this[slot] = component;
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

/** Reproduce the default host background without changing Pi's retained shell selection. */
export function withSelfBackground(shell: CodePreviewToolShell): CodePreviewToolShell {
  const row = rowPerState((context, theme) => new SelfBackgroundRow(context, theme));
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
