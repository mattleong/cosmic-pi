import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Match from "effect/Match";
import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";

const BRAILLE_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const STARTING_SPINNER_FRAMES = ["◌", "◔", "◑", "◕"] as const;

const frameAt = (frames: ReadonlyArray<string>, frame: number, fallback: string): string =>
  frames[Math.abs(Math.floor(frame)) % frames.length] ?? fallback;

export const SPINNER_FRAME_MS = 160;

export const spinnerFrameAt = (now: number): number => Math.floor(now / SPINNER_FRAME_MS);

export const startingSpinnerFrame = (frame: number): string =>
  frameAt(STARTING_SPINNER_FRAMES, frame, "◌");

/** The suite separator between inline facts and key-hint pairs; never `•`, `|`, or `│`. */
export const INLINE_SEPARATOR = " · ";

/** Joins inline facts with the suite separator, skipping empty or disabled parts. */
export const joinInline = (parts: ReadonlyArray<string | false | null | undefined>): string =>
  Arr.join(
    Arr.filter(parts, (part): part is string => Predicate.isString(part) && Str.isNonEmpty(part)),
    INLINE_SEPARATOR,
  );

/**
 * Suite-wide status glyphs; each has exactly one meaning (docs/architecture/ui-conventions.md).
 * Live running work uses the spinner from `managerActivityGlyph`; `neutral` marks a state with no
 * verdict, such as work still running in a saved snapshot, where a spinner would freeze.
 */
export const SUITE_STATUS_GLYPHS = {
  succeeded: "✓",
  failed: "✗",
  warning: "⚠",
  stopped: "⊘",
  stopping: "◒",
  uncertain: "≈",
  paused: "‖",
  queued: "○",
  waiting: "?",
  info: "ℹ",
  neutral: "•",
} as const;

export type ManagerLayoutTier = "narrow" | "stacked" | "wide";

export const managerLayoutTier = (width: number): ManagerLayoutTier =>
  width >= 100 ? "wide" : width >= 60 ? "stacked" : "narrow";

/** `attention` marks work waiting on a person's or agent's reply or decision; it is not a problem. */
export type ManagerNoticeKind = "info" | "success" | "warning" | "error" | "attention";

const MANAGER_NOTICE_GLYPHS = {
  info: "ℹ",
  success: "✓",
  warning: "⚠",
  error: "✗",
  attention: "?",
} satisfies Readonly<Record<ManagerNoticeKind, string>>;

export const managerNoticeGlyph = (kind: ManagerNoticeKind): string => MANAGER_NOTICE_GLYPHS[kind];

const MANAGER_NOTICE_COLORS = {
  info: "muted",
  success: "success",
  warning: "warning",
  error: "error",
  attention: "accent",
} as const satisfies Readonly<Record<ManagerNoticeKind, string>>;

export const managerNoticeColor = (kind: ManagerNoticeKind) => MANAGER_NOTICE_COLORS[kind];

type ManagerStateGlyphKind = "paused" | "done" | "failed" | "stopped" | "stopping";
export type ManagerActivityKind = "pending" | "running" | "waiting" | ManagerStateGlyphKind;
export type ManagerStatusColor = "accent" | "success" | "warning" | "error" | "muted" | "dim";

const MANAGER_STATE_GLYPHS = {
  paused: "‖",
  done: "✓",
  failed: "✗",
  stopped: "⊘",
  stopping: "◒",
} satisfies Readonly<Record<ManagerStateGlyphKind, string>>;

export const managerStateGlyph = (kind: ManagerStateGlyphKind): string =>
  MANAGER_STATE_GLYPHS[kind];

export const managerActivityGlyph = (kind: ManagerActivityKind, frame = 0): string =>
  Match.value(kind).pipe(
    Match.when("pending", () => startingSpinnerFrame(frame)),
    Match.when("running", () => frameAt(BRAILLE_SPINNER_FRAMES, frame, "⠋")),
    Match.when("waiting", () => managerNoticeGlyph("attention")),
    Match.orElse(managerStateGlyph),
  );

export const managerActivityColor = (kind: ManagerActivityKind): ManagerStatusColor => {
  if (kind === "pending" || kind === "running") return "accent";
  if (kind === "waiting") return managerNoticeColor("attention");
  if (kind === "done") return "success";
  if (kind === "failed") return "error";
  if (kind === "stopped" || kind === "paused") return "muted";
  return "warning";
};

const MANAGER_ACTIVITY_LABELS = {
  pending: "starting",
  running: "running",
  waiting: "waiting",
  paused: "paused",
  stopping: "stopping",
  done: "finished",
  failed: "failed",
  stopped: "stopped",
} satisfies Readonly<Record<ManagerActivityKind, string>>;

export const managerActivityLabel = (kind: ManagerActivityKind): string =>
  MANAGER_ACTIVITY_LABELS[kind];

// visibleWidth caches and has an ASCII fast path; truncateToWidth segments any non-ASCII text.
export const clipToWidth = (text: string, width: number, marker = "…"): string =>
  width > 0 && visibleWidth(text) <= width ? text : truncateToWidth(text, width, marker);

export const managerTabs = (tabs: ReadonlyArray<string>, active: number, width: number): string => {
  const full = `  ${Arr.join(tabs, "  ")}`;
  return visibleWidth(full) <= width
    ? full
    : truncateToWidth(`  ${tabs[active] ?? ""}`, Math.max(0, width), "");
};
