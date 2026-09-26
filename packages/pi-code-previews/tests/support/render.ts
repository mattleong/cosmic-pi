// Test/benchmark boundary intentionally exercises native Pi APIs behind Effect timers.
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { plainTheme } from "pi-cosmic-core/testing";
import type { CodePreviewSettings } from "../../src/config/schema";
import { renderCompactChildren } from "../../src/preview/compact-children";
import type { CompactChild } from "../../src/tools/compact-summary";
export { stripAnsi } from "pi-cosmic-core";
export { plainTheme };

export function renderComponent(component: Component, width = 100): string {
  return component.render(width).join("\n");
}

export const textResult = <Details = undefined>(
  text: string,
  details?: Details,
): AgentToolResult<Details | undefined> => ({ content: [{ type: "text", text }], details });

/** Turns off every builtin preview body so collapsed rows show only compact summaries. */
export const previewBodiesDisabled = {
  readContentPreview: false,
  writeContentPreview: false,
  editDiffPreview: false,
  grepResultPreview: false,
  findResultPreview: false,
  lsResultPreview: false,
} satisfies Partial<CodePreviewSettings>;

/** Renderer whose `factory` failure throws on construction and `draw` failure throws while drawing. */
export function failingRenderer(failure: string, lines: string[] = []): () => Component {
  return () => {
    if (failure === "factory") throw new Error("renderer construction failed");
    return {
      render: () => {
        if (failure === "draw") throw new Error("renderer drawing failed");
        return lines;
      },
      invalidate() {},
    };
  };
}

/** Renders compact children with production defaults unless an option overrides them. */
export function compactChildren(
  entries: readonly CompactChild[],
  width = 80,
  options: {
    readonly expanded?: boolean;
    readonly layout?: "tree" | "flat";
    readonly timing?: boolean;
    readonly total?: number;
    readonly frame?: number;
  } = {},
): string[] {
  const { expanded = false, layout = "tree", timing = true, total = entries.length } = options;
  const children = { entries, total };
  return renderCompactChildren(
    children,
    plainTheme,
    width,
    options.frame,
    timing,
    expanded,
    layout,
  );
}
