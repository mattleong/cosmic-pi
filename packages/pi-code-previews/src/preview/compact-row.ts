import type { Theme } from "@earendil-works/pi-coding-agent";
import { escapeControlChars } from "../shared/terminal-text";
import {
  compactStatus,
  type CompactPhase,
  type CompactStatus,
  type CompactSummary,
} from "../tools/compact-summary";
import { layoutCompactHeader } from "./compact-header";
import { compactStatusIcon } from "./compact-status";
import { TIMING_VISIBLE_MS } from "./tool-timing";

/** Subjects and metadata are plain, single-line text. ANSI input is displayed inertly. */
export function compactSingleLine(value: string): string {
  return escapeControlChars(value).replace(/\s+/gu, " ").trim();
}

type CompactRowInput = {
  name: string;
  phase: CompactPhase;
  summary: CompactSummary;
  status?: CompactStatus;
  returnedCheckmark?: true | undefined;
  /** Colored issue text that replaces the routine counter on one-line child rows. */
  issueLabel?: string | undefined;
  duration?: string | undefined;
  elapsedMs?: number | undefined;
  timingEnabled?: boolean;
  animationFrame?: number | undefined;
  expanded?: boolean;
};

/** Shared semantic heading policy. Branch decoration is outside the row's width. */
export function renderCompactRow(input: CompactRowInput, theme: Theme, width: number): string {
  return layoutCompactRow(input, theme, width).row;
}

/** The heading row plus whether its issue label fit; callers place an unfitted label below. */
export function layoutCompactRow(input: CompactRowInput, theme: Theme, width: number) {
  if (width <= 0) return { row: "", issueShown: false };
  const { phase, summary } = input;
  const status = input.status ?? compactStatus(phase, summary);
  const icon = compactStatusIcon(status, theme, input.animationFrame, input.returnedCheckmark);
  const action = compactSingleLine(summary.action ?? "");
  const prefix = `${icon} ${theme.fg("accent", compactSingleLine(input.name))}${action ? ` ${action}` : ""}`;
  const subject = compactSingleLine(
    !input.expanded ? (summary.compactSubject ?? summary.subject) : summary.subject,
  );
  const duration =
    input.timingEnabled !== false &&
    phase !== "pending" &&
    (input.elapsedMs ?? 0) >= TIMING_VISIBLE_MS
      ? compactSingleLine(input.duration ?? "")
      : undefined;
  const metadata =
    summary.metadata
      ?.map(compactSingleLine)
      .filter(Boolean)
      .map((text) => theme.fg("muted", text)) ?? [];
  const counters = input.issueLabel
    ? [input.issueLabel]
    : (summary.counters
        ?.map(compactSingleLine)
        .filter(Boolean)
        .map((text) => theme.fg("muted", text)) ?? []);
  const { row, counter } = layoutCompactHeader(
    prefix,
    subject,
    counters,
    [...metadata, !summary.showTiming && duration ? theme.fg("dim", duration) : undefined],
    width,
    theme.fg("dim", " · "),
    summary.showTiming && duration ? theme.fg("dim", duration) : undefined,
  );
  return { row, issueShown: input.issueLabel !== undefined && counter === input.issueLabel };
}

export function compactPlainText(text: string): string {
  return escapeControlChars(text.replaceAll("\r\n", "\n")).replaceAll("\t", "  ");
}
