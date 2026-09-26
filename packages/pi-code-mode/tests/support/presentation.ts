import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { withCodePreviewShell } from "pi-code-previews";
import { applyPresentationSettings, createToolPresentationHarness } from "pi-code-previews/testing";
import { plainTheme } from "pi-cosmic-core/testing";
import { vi } from "vitest";
import {
  buildCodeModeToolDefinition,
  type CodeModeToolDefinitionInput,
} from "../../src/tools/controller.ts";
import { renderCodeModeToolResult } from "../../src/ui/tool-renderer.ts";

let restoreInitial: (() => void) | undefined;

/** Applies a collapsed style with timing off until `restorePresentationSettings` runs. */
export const applyCollapsedStyle = (style: "compact" | "preview") => {
  const restore = applyPresentationSettings({
    toolCallCollapsedStyle: style,
    toolCallTiming: false,
  });
  restoreInitial ??= restore;
};

/** Register as `afterEach`: restores the settings from before the first applied style. */
export const restorePresentationSettings = () => {
  restoreInitial?.();
  restoreInitial = undefined;
};

/**
 * The registered Code Mode tool in an explicit shell mode and collapsed style, rendered through
 * the shared presentation harness. `execute` is a spy that rendering must never call.
 */
export const presentationView = (
  mode: "on" | "off" | "border",
  style: "compact" | "preview",
  startUiTicker: NonNullable<CodeModeToolDefinitionInput["startUiTicker"]> = () => () => undefined,
) => {
  applyCollapsedStyle(style);
  const execute = vi.fn(() => Promise.reject(new Error("Rendering must not execute")));
  const owned = buildCodeModeToolDefinition({
    catalogBudget: 0,
    includePowerShell: false,
    execute,
    startUiTicker,
  });
  const tool = withCodePreviewShell(owned, {
    mode,
    compactSummary: owned.compactSummary,
    expandedContent: owned.expandedContent,
  });
  return { owned, execute, view: createToolPresentationHarness(tool, { width: 500 }) };
};

/** A settled result through the owned renderer alone, as joined text. */
export const renderResultText = <Details>(
  result: AgentToolResult<Details>,
  options: { expanded: boolean; isError?: boolean; width?: number; theme?: Theme },
) =>
  renderCodeModeToolResult(result, { isPartial: false }, options.theme ?? plainTheme, {
    isError: options.isError ?? false,
    expanded: options.expanded,
  })
    .component.render(options.width ?? 240)
    .join("\n");
