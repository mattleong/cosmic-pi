import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import * as Predicate from "effect/Predicate";

const BRAILLE_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const STARTING_SPINNER_FRAMES = ["◌", "◔", "◑", "◕"] as const;

const frameAt = (frames: ReadonlyArray<string>, frame: number, fallback: string): string =>
  frames[Math.abs(Math.floor(frame)) % frames.length] ?? fallback;

export const SPINNER_FRAME_MS = 160;

export const spinnerFrameAt = (now: number): number => Math.floor(now / SPINNER_FRAME_MS);

export const startingSpinnerFrame = (frame: number): string =>
  frameAt(STARTING_SPINNER_FRAMES, frame, "◌");

export type ManagerLayoutTier = "narrow" | "stacked" | "wide";

export const managerLayoutTier = (width: number): ManagerLayoutTier =>
  width >= 100 ? "wide" : width >= 60 ? "stacked" : "narrow";

export type ManagerNoticeKind = "info" | "success" | "warning" | "error";

const MANAGER_NOTICE_GLYPHS = {
  info: "ℹ",
  success: "✓",
  warning: "⚠",
  error: "✗",
} satisfies Readonly<Record<ManagerNoticeKind, string>>;

export const managerNoticeGlyph = (kind: ManagerNoticeKind): string => MANAGER_NOTICE_GLYPHS[kind];

export const managerNoticeColor = (kind: ManagerNoticeKind) => (kind === "info" ? "muted" : kind);

type ManagerStateGlyphKind = "done" | "failed" | "stopped" | "stopping";
type ManagerAttentionKind = "waiting" | "paused";
export type ManagerActivityKind =
  | "pending"
  | "running"
  | ManagerAttentionKind
  | ManagerStateGlyphKind;
export type ManagerStatusColor = "accent" | "success" | "warning" | "error" | "muted" | "dim";

const MANAGER_STATE_GLYPHS = {
  done: "✓",
  failed: "✗",
  stopped: "⊘",
  stopping: "◒",
} satisfies Readonly<Record<ManagerStateGlyphKind, string>>;

export const managerStateGlyph = (kind: ManagerStateGlyphKind): string =>
  MANAGER_STATE_GLYPHS[kind];

export const managerActivityGlyph = (kind: ManagerActivityKind, frame = 0): string =>
  kind === "pending"
    ? startingSpinnerFrame(frame)
    : kind === "running"
      ? frameAt(BRAILLE_SPINNER_FRAMES, frame, "⠋")
      : kind === "waiting" || kind === "paused"
        ? managerNoticeGlyph("warning")
        : managerStateGlyph(kind);

export const managerActivityColor = (kind: ManagerActivityKind): ManagerStatusColor => {
  if (kind === "pending" || kind === "running") return "accent";
  if (kind === "done") return "success";
  if (kind === "failed") return "error";
  if (kind === "stopped") return "muted";
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

export const clipToWidth = (text: string, width: number, marker = "…"): string =>
  truncateToWidth(text, width, marker);

export const managerTabs = (tabs: ReadonlyArray<string>, active: number, width: number): string => {
  const full = `  ${tabs.join("  ")}`;
  return visibleWidth(full) <= width
    ? full
    : truncateToWidth(`  ${tabs[active] ?? ""}`, Math.max(0, width), "");
};

export type ManagerFooterGroup = string | undefined;

export const renderResponsiveManagerFooter = (
  contentWidth: number,
  variants: ReadonlyArray<ReadonlyArray<ManagerFooterGroup>>,
): string => {
  const safeWidth = Math.max(0, Math.floor(contentWidth));
  if (safeWidth === 0 || variants.length === 0) return "";
  const lines = variants.map((groups) => ` ${groups.filter(Predicate.isTruthy).join(" │ ")} `);
  return (
    lines.find((line) => visibleWidth(line) <= safeWidth) ??
    truncateToWidth(lines.at(-1) ?? "", safeWidth, "")
  );
};
