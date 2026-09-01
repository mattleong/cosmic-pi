// Test/benchmark boundary intentionally exercises native Pi APIs behind Effect timers.
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { type CodePreviewSettings } from "../../src/config/schema";
import { cloneCodePreviewSettings, codePreviewSettings } from "../../src/config/state";
export { stripAnsi } from "../../src/shared/terminal-text";

export function renderComponent(component: Component, width = 100): string {
  return component.render(width).join("\n");
}

export function cloneCodePreviewSettingsForTest(): CodePreviewSettings {
  return cloneCodePreviewSettings(codePreviewSettings);
}

export function testTheme(): Theme {
  // SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
  return {
    bold: (text: string) => text,
    fg: (_key: string, text: string) => text,
  } as Theme;
}
