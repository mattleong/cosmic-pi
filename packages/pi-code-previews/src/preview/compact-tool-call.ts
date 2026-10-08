import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderCompactRow, type CompactRowInput } from "./compact-row";
import { renderCompactChildren } from "./compact-children";
import { renderCompactIssues } from "./compact-issues";

/** Heading, the call's own issues, then its call tree with each child's reason on its row. */
export function renderCompactToolCall(
  input: CompactRowInput,
  theme: Theme,
  width: number,
): string[] {
  if (width <= 0) return [];
  return [
    renderCompactRow(input, theme, width),
    ...renderCompactIssues(input.summary.issues, theme, width),
    ...renderCompactChildren(input.summary.children, theme, width, {
      animationFrame: input.animationFrame,
      timingEnabled: input.timingEnabled,
    }),
  ];
}
