import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  managerActivityGlyph,
  managerNoticeGlyph,
  type ManagerActivityKind,
} from "pi-cosmic-ui/manager";
import { escapeControlChars } from "../shared/terminal-text";
import {
  compactStatus,
  type CompactNotice,
  type CompactPhase,
  type CompactSummary,
} from "../tools/compact-summary";
import { allocateCompactHeader } from "./compact-header";
import { hiddenPreviewExpandLabel } from "./format";

const ACTIVITY_KINDS = {
  pending: "pending",
  running: "running",
  success: "done",
  error: "failed",
  cancelled: "stopped",
} as const satisfies Record<string, ManagerActivityKind>;

/** Subjects and metadata are plain, single-line text. ANSI input is displayed inertly. */
export function compactSingleLine(value: string): string {
  return escapeControlChars(value).replace(/\s+/gu, " ").trim();
}

export function renderCompactNotices(
  notices: readonly CompactNotice[] | undefined,
  theme: Theme,
  width: number,
): string[] {
  if (width <= 0) return [];
  return (notices ?? []).flatMap((notice) => {
    const color = notice.kind === "error" ? "error" : "warning";
    // Preserve every notice line, including continuation and recovery instructions.
    return indentedCompactText(notice.text, "  ╰─ ", color, theme, width);
  });
}

export function renderCompactToolCall(
  input: {
    name: string;
    phase: CompactPhase;
    summary: CompactSummary;
    duration?: string | undefined;
    animationFrame?: number | undefined;
    expanded?: boolean;
  },
  theme: Theme,
  width: number,
): string[] {
  if (width <= 0) return [];
  const { phase, summary } = input;
  const status = compactStatus(phase, summary);
  const glyph =
    status === "warning" || status === "uncertain"
      ? managerNoticeGlyph("warning")
      : managerActivityGlyph(ACTIVITY_KINDS[status], input.animationFrame ?? 0);
  const color =
    status === "success"
      ? "success"
      : status === "error"
        ? "error"
        : status === "cancelled"
          ? "muted"
          : "warning";
  const action = compactSingleLine(summary.action ?? "");
  const prefix = `${theme.fg(color, glyph)} ${theme.fg("toolTitle", compactSingleLine(input.name))}${action ? ` ${action}` : ""}`;
  const subject = compactSingleLine(summary.subject);
  const hint = input.expanded ? undefined : hiddenPreviewExpandLabel(theme);
  const duration = phase === "pending" ? undefined : compactSingleLine(input.duration ?? "");
  const metadata = summary.metadata?.map(compactSingleLine).filter(Boolean) ?? [];
  const counters = summary.counters?.map(compactSingleLine).filter(Boolean) ?? [];
  const row = allocateCompactHeader(
    prefix,
    subject,
    counters,
    [...metadata, duration, hint],
    width,
  );
  return [row, ...renderCompactNotices(summary.notices, theme, width)];
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

function compactPlainText(text: string): string {
  return escapeControlChars(text.replaceAll("\r\n", "\n")).replaceAll("\t", "  ");
}

function indentedCompactText(
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
