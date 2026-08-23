// Test/benchmark boundary intentionally exercises native Pi APIs behind Effect timers.
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { type CodePreviewSettings } from "../config/schema";
import { cloneCodePreviewSettings, codePreviewSettings } from "../config/state";
import type { RendererArguments, RendererState } from "../tools/renderers/shared/types";
export { stripAnsi } from "../shared/terminal-text";

export function renderComponent(component: Component, width = 100): string {
  return component.render(width).join("\n");
}

export function delay(ms: number): Promise<void> {
  return Effect.runPromise(Effect.sleep(Duration.millis(ms)));
}

export interface TestToolRenderContext {
  args: RendererArguments;
  argsComplete: boolean;
  cwd: string;
  executionStarted: boolean;
  expanded: boolean;
  invalidate: () => void;
  isError: boolean;
  isPartial: boolean;
  lastComponent: Component | undefined;
  showImages: boolean;
  state: RendererState;
  toolCallId: string;
}

export function cloneCodePreviewSettingsForTest(): CodePreviewSettings {
  return cloneCodePreviewSettings(codePreviewSettings);
}

export function createToolRenderContext(
  overrides: Partial<TestToolRenderContext> = {},
): TestToolRenderContext {
  return {
    args: {},
    argsComplete: true,
    cwd: "/tmp/project",
    executionStarted: false,
    expanded: true,
    invalidate: () => undefined,
    isError: false,
    isPartial: true,
    lastComponent: undefined,
    showImages: true,
    state: {},
    toolCallId: "tool-1",
    ...overrides,
  };
}

export function testTheme(): Theme {
  // SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
  return {
    bold: (text: string) => text,
    fg: (_key: string, text: string) => text,
  } as Theme;
}
