import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { managerNoticeGlyph, clipToWidth } from "pi-cosmic-ui/manager";
import type { CompactIssue } from "../tools/compact-issues";
import { compactPlainText, compactSingleLine } from "./compact-row";

const COLORS = { error: "error", warning: "warning", info: "muted" } as const;
const glyph = (severity: CompactIssue["severity"]) => managerNoticeGlyph(severity);

/** The issue shown on a collapsed one-line row: the first error, else the first warning. */
export function primaryCompactIssue(
  issues: readonly CompactIssue[] | undefined,
): CompactIssue | undefined {
  return (
    issues?.find((issue) => issue.severity === "error") ??
    issues?.find((issue) => issue.severity === "warning")
  );
}

/** Issue text for a one-line row, with a count of the row's other attention issues. */
export function compactIssueLabel(issues: readonly CompactIssue[], theme: Theme): string {
  const primary = primaryCompactIssue(issues);
  if (!primary) return "";
  const others = issues.filter((issue) => issue.severity !== "info").length - 1;
  return theme.fg(
    COLORS[primary.severity],
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
  const rows: string[] = [];
  for (const issue of issues) {
    if (issue.severity === "info" && !expanded) continue;
    const message = compactSingleLine(issue.message);
    if (!message) continue;
    const color = COLORS[issue.severity];
    const prefix = `${indent}${glyph(issue.severity)} `;
    // Surrender decoration before losing text on very narrow rows.
    const hang = width - visibleWidth(prefix) >= 2 ? visibleWidth(prefix) : 0;
    const pad = " ".repeat(hang);
    wrapTextWithAnsi(theme.fg(color, message), width - hang).forEach((line, index) =>
      rows.push(
        clipToWidth(
          `${hang ? (index === 0 ? theme.fg(color, prefix) : pad) : ""}${line}`,
          width,
          "",
        ),
      ),
    );
    if (!expanded || !issue.detail) continue;
    for (const line of compactPlainText(issue.detail).split("\n"))
      for (const part of wrapTextWithAnsi(theme.fg("dim", line), width - hang))
        rows.push(clipToWidth(`${pad}${part}`, width, ""));
  }
  return rows;
}
