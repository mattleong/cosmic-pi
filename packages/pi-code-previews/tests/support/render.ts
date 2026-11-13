import {
  createReadToolDefinition,
  type AgentToolResult,
  type MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { keybindingHintsFixture, plainTheme } from "pi-cosmic-core/testing";
import type { CodePreviewSettings } from "../../src/config/schema";
import { renderCompactChildren } from "../../src/preview/compact-children";
import { applyPresentationSettings } from "../../src/testing/tool-presentation";
import type { BuiltinCompactProjectionInput } from "../../src/tools/builtin-projection";
import type { CompactChild, CompactSummary } from "../../src/tools/compact-summary";
import type { BuiltinCompactTool } from "../../src/tools/builtin-subject";
import { withCodePreviewShell } from "../../src/tools/cooperative-tools";
import { createBuiltinPreviewRenderers } from "../../src/tools/renderers/registration";
import { getEnabledCodePreviewTools } from "../../src/tools/selection";
export { stripAnsi } from "pi-cosmic-core";
export { plainTheme };

export function renderComponent(component: Component, width = 100): string {
  return Arr.join(component.render(width), "\n");
}

export { getTextContent as resultText } from "../../src/tools/data/results";

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

/** How many times `phrase` occurs in `text`. */
export const occurrences = (text: string, phrase: string): number =>
  Str.split(text, phrase).length - 1;

/** Applies a collapsed style and row background for the test at hand. */
export const applyRowStyle = (
  style: CodePreviewSettings["toolCallCollapsedStyle"],
  background: CodePreviewSettings["toolCallBackground"] = "off",
) => applyPresentationSettings({ toolCallCollapsedStyle: style, toolCallBackground: background });

/** The policy and evidence defaults a builtin projection input starts from. */
export const builtinProjectionPolicy = {
  phase: "settled",
  beforeWrite: { kind: "unknown" },
  secretWarnings: true,
  bashWarnings: true,
  secretScanChars: 8000,
  maxWriteDiffBytes: 100000,
  maxWriteDiffChangedLineCells: 10000,
} satisfies Partial<BuiltinCompactProjectionInput>;

type ReadDefinition = ReturnType<typeof createReadToolDefinition>;

/**
 * A shell-wrapped tool for presentation tests: a `Demo call` heading, a `Demo result` body, the
 * given compact summary, and an expanded body that shows `Everything retained`, each replaceable.
 * The shell captures its mode when wrapping, so build the tool after applying settings.
 */
export const demoShellTool = (
  summary: (phase: string) => CompactSummary,
  parts: {
    readonly call?: NonNullable<ReadDefinition["renderCall"]>;
    readonly result?: NonNullable<ReadDefinition["renderResult"]>;
    readonly expandedResult?: () => Component;
  } = {},
) =>
  withCodePreviewShell(
    {
      ...createReadToolDefinition("/project"),
      renderCall: parts.call ?? (() => new Text("Demo call", 0, 0)),
      renderResult: parts.result ?? (() => new Text("Demo result", 0, 0)),
    },
    {
      compactSummary: ({ phase }) => summary(phase),
      expandedContent: {
        renderCall: () => new Container(),
        renderResult: parts.expandedResult ?? (() => new Text("Everything retained", 0, 0)),
      },
    },
  );

type CustomMessage = Parameters<MessageRenderer>[0];

/** A displayed custom message, as Pi hands one to a message renderer. */
export const customMessage = (overrides: Partial<CustomMessage> = {}): CustomMessage => ({
  role: "custom",
  customType: "example-message",
  content: [{ type: "text", text: "FULL MODEL-FACING CONTENT" }],
  display: true,
  timestamp: 0,
  ...overrides,
});

/** The rows a message renderer draws for a message, collapsed or expanded. */
export const drawMessage = (
  render: MessageRenderer,
  expanded: boolean,
  message: CustomMessage = customMessage(),
  width = 80,
): string[] =>
  render(message, { ...keybindingHintsFixture, expanded, outputPad: 1 }, plainTheme)?.render(
    width,
  ) ?? [];
