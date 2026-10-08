import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { clipToWidth, managerNoticeColor, managerNoticeGlyph } from "pi-cosmic-ui/manager";
import type { CompactIssue } from "../tools/compact-issues";
import { compactPlainText, compactSingleLine } from "./compact-row";

/**
 * Wraps text under a hanging prefix: `first` leads the first line and `rest` the others. On rows
 * leaving fewer than `minimum` cells for text, the decoration yields before the text does.
 */
export function wrapHanging(
  text: string,
  width: number,
  first: string,
  rest: string,
  minimum: number,
): string[] {
  const indent = width - visibleWidth(first) >= minimum ? visibleWidth(first) : 0;
  return wrapTextWithAnsi(text, width - indent).map((line, index) =>
    clipToWidth(`${indent ? (index === 0 ? first : rest) : ""}${line}`, width, ""),
  );
}

/**
 * Issue text for a one-line row: the first error, else the first warning, with a count of the
 * row's other attention issues.
 */
export function compactIssueLabel(issues: readonly CompactIssue[], theme: Theme): string {
  const primary =
    issues.find((issue) => issue.severity === "error") ??
    issues.find((issue) => issue.severity === "warning");
  if (!primary) return "";
  const others = issues.filter((issue) => issue.severity !== "info").length - 1;
  return theme.fg(
    managerNoticeColor(primary.severity),
    `${compactSingleLine(primary.message)}${others > 0 ? ` (+${others})` : ""}`,
  );
}

/**
 * One line per issue, each with its own glyph and color. Collapsed rows show messages only;
 * expansion adds informational issues and each issue's dimmed detail beneath its message.
 */
export function renderCompactIssues(
  issues: readonly CompactIssue[] | undefined,
  theme: Pick<Theme, "fg">,
  width: number,
  expanded = false,
  indent = "  ",
): string[] {
  if (!issues?.length || width <= 0) return [];
  return issues.flatMap((issue) => {
    if (issue.severity === "info" && !expanded) return [];
    const message = compactSingleLine(issue.message);
    if (!message) return [];
    const color = managerNoticeColor(issue.severity);
    const prefix = `${indent}${managerNoticeGlyph(issue.severity)} `;
    // Surrender decoration before losing text on very narrow rows.
    const pad = " ".repeat(width - visibleWidth(prefix) >= 2 ? visibleWidth(prefix) : 0);
    const rows = wrapHanging(theme.fg(color, message), width, theme.fg(color, prefix), pad, 2);
    if (!expanded || !issue.detail) return rows;
    return rows.concat(
      compactPlainText(issue.detail)
        .split("\n")
        .flatMap((line) => wrapHanging(theme.fg("dim", line), width, pad, pad, 0)),
    );
  });
}
