import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { escapeControlChars } from "../shared/terminal-text";
import {
  compactStatus,
  isCompactAttention,
  type CompactNotice,
  type CompactPhase,
  type CompactSummary,
} from "../tools/compact-summary";
import { allocateCompactHeader } from "./compact-header";
import { compactStatusIcon } from "./compact-status";

/** Subjects and metadata are plain, single-line text. ANSI input is displayed inertly. */
export function compactSingleLine(value: string): string {
  return escapeControlChars(value).replace(/\s+/gu, " ").trim();
}

/** Shared semantic heading policy. Branch decoration is outside the row's width. */
export function renderCompactRow(
  input: {
    name: string;
    phase: CompactPhase;
    summary: CompactSummary;
    status?: Parameters<typeof compactStatusIcon>[0];
    duration?: string | undefined;
    elapsedMs?: number | undefined;
    timingEnabled?: boolean;
    animationFrame?: number | undefined;
  },
  theme: Theme,
  width: number,
): string {
  if (width <= 0) return "";
  const { phase, summary } = input;
  const status = input.status ?? compactStatus(phase, summary);
  const icon = compactStatusIcon(status, theme, input.animationFrame);
  const action = compactSingleLine(summary.action ?? "");
  const prefix = `${icon} ${theme.fg("accent", compactSingleLine(input.name))}${action ? ` ${action}` : ""}`;
  const subject = compactSingleLine(summary.subject);
  const duration =
    input.timingEnabled !== false &&
    phase !== "pending" &&
    (summary.showTiming || input.name === "bash" || (input.elapsedMs ?? 0) >= 10_000)
      ? compactSingleLine(input.duration ?? "")
      : undefined;
  const metadata =
    summary.metadata
      ?.map(compactSingleLine)
      .filter(Boolean)
      .map((text) => theme.fg("muted", text)) ?? [];
  const counters =
    summary.counters
      ?.map(compactSingleLine)
      .filter(Boolean)
      .map((text) => theme.fg("muted", text)) ?? [];
  const row = allocateCompactHeader(
    prefix,
    subject,
    counters,
    [...metadata, !summary.showTiming && duration ? theme.fg("dim", duration) : undefined],
    width,
    theme.fg("dim", " · "),
    summary.showTiming && duration ? theme.fg("dim", duration) : undefined,
  );
  return row;
}

export function renderCompactNotices(
  notices: readonly CompactNotice[] | undefined,
  theme: Theme,
  width: number,
  expanded = false,
): string[] {
  if (width <= 0) return [];
  return (notices ?? []).flatMap((notice) => {
    const attention = isCompactAttention(notice);
    if (!expanded && !attention) return [];
    const color = notice.kind === "error" ? "error" : attention ? "warning" : "muted";
    // Preserve every notice line, including continuation and recovery instructions.
    return indentedCompactText(notice.text, "  ╰─ ", color, theme, width);
  });
}

export function compactPlainText(text: string): string {
  return escapeControlChars(text.replaceAll("\r\n", "\n")).replaceAll("\t", "  ");
}

export function indentedCompactText(
  text: string,
  prefix: string,
  color: "muted" | "warning" | "error",
  theme: Theme,
  width: number,
): string[] {
  // Leave room for a wide grapheme rather than letting decorative indentation erase it.
  const indent = width - visibleWidth(prefix) >= 2 ? visibleWidth(prefix) : 0;
  const lines = compactPlainText(text)
    .split("\n")
    .flatMap((line) => wrapTextWithAnsi(theme.fg(color, line), width - indent));
  return lines.map((line, index) =>
    truncateToWidth(
      `${indent ? (index === 0 ? theme.fg(color, prefix) : " ".repeat(indent)) : ""}${line}`,
      width,
      "",
    ),
  );
}
