import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  managerActivityColor,
  managerActivityGlyph,
  managerNoticeGlyph,
  type ManagerActivityKind,
} from "pi-cosmic-ui/manager";
import { escapeControlChars } from "../shared/terminal-text";
import {
  compactStatus,
  type CompactPhase,
  type CompactStatus,
  type CompactSummary,
} from "../tools/compact-summary";
import { layoutCompactHeader } from "./compact-header";
import { TIMING_VISIBLE_MS } from "./tool-timing";

export function compactSingleLine(value: string): string {
  return escapeControlChars(value).replace(/\s+/gu, " ").trim();
}

export type CompactRowInput = {
  name: string;
  phase: CompactPhase;
  summary: CompactSummary;
  status?: CompactStatus;
  returnedCheckmark?: true | undefined;
  issueLabel?: string | undefined;
  duration?: string | undefined;
  elapsedMs?: number | undefined;
  timingEnabled?: boolean;
  animationFrame?: number | undefined;
  expanded?: boolean;
};

const ACTIVITY_KINDS = {
  pending: "pending",
  running: "running",
  success: "done",
  error: "failed",
  cancelled: "stopped",
} as const satisfies Record<string, ManagerActivityKind>;

function compactStatusIcon(
  status: CompactStatus,
  theme: Theme,
  animationFrame = 0,
  returnedCheckmark = false,
): string {
  if (status === "returned")
    return theme.fg("muted", returnedCheckmark ? managerActivityGlyph("done") : "•");
  if (status === "uncertain") return theme.fg("warning", "?");
  if (status === "warning") return theme.fg("warning", managerNoticeGlyph("warning"));
  const kind = ACTIVITY_KINDS[status];
  return theme.fg(managerActivityColor(kind), managerActivityGlyph(kind, animationFrame));
}

export function renderCompactRow(input: CompactRowInput, theme: Theme, width: number): string {
  return layoutCompactRow(input, theme, width).row;
}

function compactRowDuration(input: CompactRowInput): string | undefined {
  const { elapsedMs } = input;
  const visible =
    input.timingEnabled !== false &&
    input.phase !== "pending" &&
    elapsedMs !== undefined &&
    Number.isFinite(elapsedMs) &&
    elapsedMs >= 0 &&
    (input.summary.showShortTiming || elapsedMs >= TIMING_VISIBLE_MS);
  return visible ? compactSingleLine(input.duration ?? "") : undefined;
}

function compactRowPrefix(input: CompactRowInput, theme: Theme): string {
  const status = input.status ?? compactStatus(input.phase, input.summary);
  const icon = compactStatusIcon(status, theme, input.animationFrame, input.returnedCheckmark);
  const action = compactSingleLine(input.summary.action ?? "");
  return `${icon} ${theme.fg("accent", compactSingleLine(input.name))}${action ? ` ${action}` : ""}`;
}

function compactRowSubject({ expanded, summary }: CompactRowInput): string {
  return compactSingleLine(
    !expanded ? (summary.compactSubject ?? summary.subject) : summary.subject,
  );
}

export function layoutCompactRow(input: CompactRowInput, theme: Theme, width: number) {
  if (width <= 0) return { row: "", issueShown: false };
  const { summary } = input;
  const duration = compactRowDuration(input);
  const timing = duration ? theme.fg("dim", duration) : undefined;
  const muted = (values: readonly string[] | undefined) =>
    values
      ?.map(compactSingleLine)
      .filter(Boolean)
      .map((text) => theme.fg("muted", text)) ?? [];
  const { row, counter } = layoutCompactHeader(
    compactRowPrefix(input, theme),
    compactRowSubject(input),
    input.issueLabel ? [input.issueLabel] : muted(summary.counters),
    [...muted(summary.metadata), summary.showTiming ? undefined : timing],
    width,
    theme.fg("dim", " · "),
    summary.showTiming ? timing : undefined,
  );
  return { row, issueShown: input.issueLabel !== undefined && counter === input.issueLabel };
}

export function compactPlainText(text: string): string {
  return escapeControlChars(text.replaceAll("\r\n", "\n")).replaceAll("\t", "  ");
}
