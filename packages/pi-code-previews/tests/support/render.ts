import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import { plainTheme } from "pi-cosmic-core/testing";
import type { CodePreviewSettings } from "../../src/config/schema";
import { renderCompactChildren } from "../../src/preview/compact-children";
import type { CompactChild } from "../../src/tools/compact-summary";
import type { BuiltinCompactTool } from "../../src/tools/builtin-subject";
import { createBuiltinPreviewRenderers } from "../../src/tools/renderers/registration";
import { getEnabledCodePreviewTools } from "../../src/tools/selection";
export { stripAnsi } from "pi-cosmic-core";
export { plainTheme };

export function renderComponent(component: Component, width = 100): string {
  return component.render(width).join("\n");
}

export const resultText = (content: AgentToolResult<unknown>["content"]): string =>
  Arr.filterMap(content, (part) =>
    part.type === "text" ? Result.succeed(part.text) : Result.failVoid,
  ).join("\n");

export const textResult = <Details = undefined>(
  text: string,
  details?: Details,
): AgentToolResult<Details | undefined> => ({ content: [{ type: "text", text }], details });

export const previewBodiesDisabled = {
  readContentPreview: false,
  writeContentPreview: false,
  editDiffPreview: false,
  grepResultPreview: false,
  findResultPreview: false,
  lsResultPreview: false,
} satisfies Partial<CodePreviewSettings>;

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

export function compactChildren(
  entries: readonly CompactChild[],
  width = 80,
  options: {
    readonly all?: boolean;
    readonly layout?: "tree" | "flat";
    readonly timing?: boolean;
    readonly total?: number;
    readonly frame?: number;
  } = {},
): string[] {
  const { layout = "tree", timing = true, total = entries.length } = options;
  return renderCompactChildren({ entries, total }, plainTheme, width, {
    layout,
    timingEnabled: timing,
    all: options.all ?? false,
    animationFrame: options.frame,
  });
}

export const builtinRenderers = (name: BuiltinCompactTool, selfShell = false) =>
  createBuiltinPreviewRenderers(name, {
    cwd: "/project",
    selfShell,
    scheduleAnimation: () => () => undefined,
    enabledTools: [...getEnabledCodePreviewTools()],
  });
