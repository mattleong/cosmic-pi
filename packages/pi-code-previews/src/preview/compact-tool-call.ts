import type { Theme } from "@earendil-works/pi-coding-agent";
import { type CompactPhase, type CompactSummary } from "../tools/compact-summary";
import {
  renderCompactRow,
  renderCompactNotices,
  compactPlainText,
  indentedCompactText,
} from "./compact-row";
export { renderCompactNotices } from "./compact-row";
export { compactSingleLine } from "./compact-row";

import { renderCompactChildren } from "./compact-children";

export function renderCompactToolCall(
  input: {
    name: string;
    phase: CompactPhase;
    summary: CompactSummary;
    duration?: string | undefined;
    elapsedMs?: number | undefined;
    timingEnabled?: boolean;
    animationFrame?: number | undefined;
    expanded?: boolean;
  },
  theme: Theme,
  width: number,
): string[] {
  if (width <= 0) return [];
  const { summary } = input;
  const row = renderCompactRow(input, theme, width);
  const children = input.expanded
    ? []
    : renderCompactChildren(
        summary.children,
        theme,
        width,
        input.animationFrame,
        input.timingEnabled,
      );
  return [row, ...children, ...renderCompactNotices(summary.notices, theme, width)];
}

/** An explicit failure owns both compact and expanded text. Never stack the original card. */
export function renderCompactFailure(
  input: Parameters<typeof renderCompactToolCall>[0] & {
    failure: NonNullable<CompactSummary["failure"]>;
  },
  theme: Theme,
  width: number,
): string[] {
  if (width <= 0) return [];
  const { summary, failure, expanded } = input;
  const header = renderCompactToolCall(
    { ...input, summary: { ...summary, notices: [] } },
    theme,
    width,
  );
  const color =
    summary.outcome === "cancelled"
      ? "muted"
      : summary.outcome === "uncertain"
        ? "warning"
        : "error";
  const text = expanded ? failure.details : failure.cause;
  const body = indentedCompactText(text, expanded ? "  " : "  ╰─ ", color, theme, width);
  // Compare semantic plain text only, never rendered components. A contained notice is
  // already visible in full, including on the conservative unknown-error path.
  const visibleText = compactPlainText(text);
  const notices = summary.notices?.filter(
    (notice) => !visibleText.includes(compactPlainText(notice.text)),
  );
  return [...header, ...body, ...renderCompactNotices(notices, theme, width)];
}
