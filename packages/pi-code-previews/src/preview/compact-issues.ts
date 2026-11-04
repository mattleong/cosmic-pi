import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import * as Option from "effect/Option";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { clipToWidth, managerNoticeColor, managerNoticeGlyph } from "pi-cosmic-ui/manager";
import { compactIssueSeverity, type CompactIssue } from "../tools/compact-issues";
import type { CompactDetail } from "../tools/compact-summary";
import { compactPlainText, compactSingleLine } from "./compact-row";

const sentence = (text: string) => Fn.pipe(compactSingleLine(text), Str.replace(/\.$/u, ""));

/**
 * Whether text says exactly what one of the issues says, apart from spacing and a final period.
 * Expansion omits such text, an error section included, because the issue already shows it.
 */
export function repeatsIssueMessage(
  text: string,
  issues: readonly Pick<CompactIssue, "message">[] | undefined,
): boolean {
  const said = sentence(text);
  return said !== "" && Arr.some(issues ?? [], (issue) => sentence(issue.message) === said);
}

/** Labeled plain facts beneath an expanded child call, such as its registered name. */
export function renderCompactDetails(
  details: readonly CompactDetail[] | undefined,
  theme: Pick<Theme, "fg">,
  width: number,
  indent = "  ",
): string[] {
  if (!details?.length || width <= 0) return [];
  return Arr.flatMap(details, ({ label, text }) => {
    const value = Str.trim(compactPlainText(text));
    if (!value) return [];
    const first = `${indent}${theme.fg("muted", compactSingleLine(label))} `;
    const pad = Fn.pipe(" ", Str.repeat(visibleWidth(first)));
    return Arr.flatMap(Str.split(value, "\n"), (line, index) =>
      wrapHanging(theme.fg("toolOutput", line), width, index === 0 ? first : pad, pad, 8),
    );
  });
}

export function wrapHanging(
  text: string,
  width: number,
  first: string,
  rest: string,
  minimum: number,
): string[] {
  const indent = width - visibleWidth(first) >= minimum ? visibleWidth(first) : 0;
  return Arr.map(wrapTextWithAnsi(text, width - indent), (line, index) =>
    clipToWidth(`${indent ? (index === 0 ? first : rest) : ""}${line}`, width, ""),
  );
}

export function compactIssueLabel(issues: readonly CompactIssue[], theme: Theme): string {
  const severity = compactIssueSeverity(issues);
  const primary = Option.getOrUndefined(
    Arr.findFirst(issues, (issue) => issue.severity === severity),
  );
  if (!primary) return "";
  const others = Arr.filter(issues, (issue) => issue.severity !== "info").length - 1;
  return theme.fg(
    managerNoticeColor(primary.severity),
    `${compactSingleLine(primary.message)}${others > 0 ? ` (+${others})` : ""}`,
  );
}

export function renderCompactIssues(
  issues: readonly CompactIssue[] | undefined,
  theme: Pick<Theme, "fg">,
  width: number,
  expanded = false,
  indent = "  ",
): string[] {
  if (!issues?.length || width <= 0) return [];
  return Arr.flatMap(issues, (issue) => {
    if (issue.severity === "info" && !expanded) return [];
    const message = compactSingleLine(issue.message);
    if (!message) return [];
    const color = managerNoticeColor(issue.severity);
    const prefix = `${indent}${managerNoticeGlyph(issue.severity)} `;
    const pad = Fn.pipe(
      " ",
      Str.repeat(width - visibleWidth(prefix) >= 2 ? visibleWidth(prefix) : 0),
    );
    const rows = wrapHanging(theme.fg(color, message), width, theme.fg(color, prefix), pad, 2);
    // Detail that only repeats the message adds nothing: the message already shows those words.
    if (!expanded || !issue.detail || repeatsIssueMessage(issue.detail, [issue])) return rows;
    return rows.concat(
      Arr.flatMap(Str.split(compactPlainText(issue.detail), "\n"), (line) =>
        wrapHanging(theme.fg("dim", line), width, pad, pad, 0),
      ),
    );
  });
}
