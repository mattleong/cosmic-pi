import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { findOrUndefined } from "pi-cosmic-core/array";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  clipToWidth,
  managerNoticeColor,
  managerNoticeGlyph,
  wrapFacts,
} from "pi-cosmic-ui/manager";
import { paintLineCounts } from "pi-cosmic-ui/tool";
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
): string[] {
  if (!details?.length || width <= 0) return [];
  return Arr.flatMap(details, ({ label, text, verbatim }) => {
    const value = Str.trim(compactPlainText(text));
    if (!value) return [];
    const first = `  ${theme.fg("muted", compactSingleLine(label))} `;
    const pad = Fn.pipe(" ", Str.repeat(visibleWidth(first)));
    return Arr.flatMap(Str.split(value, "\n"), (line, index) =>
      wrapHanging(line, width, index === 0 ? first : pad, pad, 8, {
        style: (row) => theme.fg("toolOutput", row),
        verbatim: verbatim === true,
      }),
    );
  });
}

/** How {@link wrapHanging} draws and breaks its rows. */
export interface HangingWrap {
  /** Draws each plain row, such as in a theme color. */
  readonly style?: ((row: string) => string) | undefined;
  /** Raw evidence such as JSON, which breaks where each row ends instead of between facts. */
  readonly verbatim?: boolean | undefined;
  /** Further indent for a line's continuation rows past `rest`, so they read as one line. */
  readonly hang?: string | undefined;
}

/**
 * Plain `text` wrapped as Details wrap it, with `first` before its first row and `rest` before the
 * others: between whole `·` facts, then between words, and a long path after its last `/` before
 * inside its file name. Narrower than `minimum` beside `first`, rows drop both leads.
 */
export function wrapHanging(
  text: string,
  width: number,
  first: string,
  rest: string,
  minimum: number,
  { style = Fn.identity, verbatim = false, hang = "" }: HangingWrap = {},
): string[] {
  const indent = width - visibleWidth(first) >= minimum ? visibleWidth(first) : 0;
  const room = Math.max(1, width - indent);
  const rows = verbatim ? wrapTextWithAnsi(text, room) : wrapFacts(text, room, hang);
  return Arr.map(rows.length > 0 ? rows : [""], (line, index) =>
    clipToWidth(
      `${indent ? (index === 0 ? first : rest) : ""}${line === "" ? "" : style(line)}`,
      width,
      "",
    ),
  );
}

/** The issue a compact row names in its counter's place, as plain text and its notice color. */
export function compactIssueText(
  issues: readonly CompactIssue[],
): { readonly text: string; readonly color: ReturnType<typeof managerNoticeColor> } | undefined {
  const severity = compactIssueSeverity(issues);
  const primary = findOrUndefined(issues, (issue) => issue.severity === severity);
  if (!primary) return undefined;
  const others = Arr.filter(issues, (issue) => issue.severity !== "info").length - 1;
  return {
    text: `${compactSingleLine(primary.message)}${others > 0 ? ` (+${others})` : ""}`,
    color: managerNoticeColor(primary.severity),
  };
}

const DETAIL_HANG = "  ";

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
    const rows = wrapHanging(message, width, theme.fg(color, prefix), pad, 2, {
      style: (row) => theme.fg(color, row),
    });
    // Detail that only repeats the message adds nothing: the message already shows those words.
    if (!expanded || !issue.detail || repeatsIssueMessage(issue.detail, [issue])) return rows;
    // A detail line's continuation hangs, so it reads apart from the next detail line.
    return rows.concat(
      Arr.flatMap(Str.split(compactPlainText(issue.detail), "\n"), (line) =>
        wrapHanging(line, width, pad, pad, 0, {
          style: (row) => paintLineCounts(theme, row, "dim"),
          hang: DETAIL_HANG,
        }),
      ),
    );
  });
}
