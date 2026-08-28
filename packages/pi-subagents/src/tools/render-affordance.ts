import type { Theme } from "@earendil-works/pi-coding-agent";

export const renderExpansionAffordance = (
  label: string,
  expanded: boolean,
  theme: Theme,
  hint = "ctrl+o to expand",
): string => {
  const suffix = expanded || !hint ? "" : ` · ${hint}`;
  return `${theme.fg("accent", expanded ? "▾" : "▸")} ${theme.fg("muted", `${label}${suffix}`)}`;
};
