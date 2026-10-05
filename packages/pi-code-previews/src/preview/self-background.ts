import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { ToolRenderContext } from "../tools/renderers/shared/types";
import type { CodePreviewToolShell } from "./tool-shell";

/** A fixed self shell can adopt settings after Pi has retained a replayed row. */
class SelfBackgroundRow implements Component {
  private readonly box: Box;
  private call: Component | undefined;
  private result: Component | undefined;
  readonly resultSlot: Component;

  private context: ToolRenderContext;
  private theme: Theme;

  constructor(context: ToolRenderContext, theme: Theme) {
    this.context = context;
    this.theme = theme;
    this.box = new Box(1, 1, (text) =>
      this.theme.bg(
        this.context.isError
          ? "toolErrorBg"
          : this.context.isPartial
            ? "toolPendingBg"
            : "toolSuccessBg",
        text,
      ),
    );
    this.resultSlot = {
      render: (width) => (this.call ? [] : this.render(width)),
      handleMouse: (event) => (this.call ? undefined : this.handleMouse(event)),
      invalidate: () => {
        if (!this.call) this.invalidate();
      },
    };
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
  const rows = new WeakMap<object, SelfBackgroundRow>();
  const row = (context: ToolRenderContext, theme: Theme) => {
    let current = rows.get(context.state);
    if (!current) {
      current = new SelfBackgroundRow(context, theme);
      rows.set(context.state, current);
    }
    return current;
  };
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
