import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

export const renderComponent = (render: (width: number) => string[]): Component => ({
  render,
  invalidate() {},
});

export const renderExpansionAffordance = (
  label: string,
  expanded: boolean,
  theme: Theme,
  hint = "ctrl+o to expand",
): string => {
  const suffix = expanded || !hint ? "" : ` · ${hint}`;
  return `${theme.fg("accent", expanded ? "▾" : "▸")} ${theme.fg("muted", `${label}${suffix}`)}`;
};
