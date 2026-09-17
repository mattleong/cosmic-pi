import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const BRAILLE_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const STARTING_SPINNER_FRAMES = ["◌", "◔", "◑", "◕"] as const;

const frameAt = (frames: ReadonlyArray<string>, frame: number, fallback: string): string =>
  frames[Math.abs(Math.floor(frame)) % frames.length] ?? fallback;

export const brailleSpinnerFrame = (frame: number): string =>
  frameAt(BRAILLE_SPINNER_FRAMES, frame, "⠋");

export const startingSpinnerFrame = (frame: number): string =>
  frameAt(STARTING_SPINNER_FRAMES, frame, "◌");

export type ManagerLayoutTier = "narrow" | "stacked" | "wide";

/** Shared responsive manager tiers: narrow below 60, stacked 60–99, wide at 100+ columns. */
export const managerLayoutTier = (width: number): ManagerLayoutTier =>
  width >= 100 ? "wide" : width >= 60 ? "stacked" : "narrow";

export type ManagerNoticeKind = "info" | "success" | "warning" | "error";

const MANAGER_NOTICE_GLYPHS = {
  info: "ℹ",
  success: "✓",
  warning: "⚠",
  error: "✗",
} satisfies Readonly<Record<ManagerNoticeKind, string>>;

/** Shared status glyph vocabulary for manager notices and feedback lines. */
export const managerNoticeGlyph = (kind: ManagerNoticeKind): string => MANAGER_NOTICE_GLYPHS[kind];

export type ManagerStateGlyphKind = "done" | "failed" | "stopped" | "stopping";
export type ManagerActivityKind = "pending" | "running" | ManagerStateGlyphKind;
export type ManagerStatusColor = "accent" | "success" | "warning" | "error" | "muted" | "dim";

const MANAGER_STATE_GLYPHS = {
  done: "✓",
  failed: "✗",
  stopped: "⊘",
  stopping: "◒",
} satisfies Readonly<Record<ManagerStateGlyphKind, string>>;

/** Shared terminal-state glyph pairs for manager rows (`/subagents`, `/tasks`). */
export const managerStateGlyph = (kind: ManagerStateGlyphKind): string =>
  MANAGER_STATE_GLYPHS[kind];

/** Total semantic activity projection shared by managers and tool renderers. */
export const managerActivityGlyph = (kind: ManagerActivityKind, frame = 0): string =>
  kind === "pending"
    ? startingSpinnerFrame(frame)
    : kind === "running"
      ? brailleSpinnerFrame(frame)
      : managerStateGlyph(kind);

/** Theme-token policy for the shared activity vocabulary. */
export const managerActivityColor = (kind: ManagerActivityKind): ManagerStatusColor => {
  if (kind === "pending") return "accent";
  if (kind === "running" || kind === "done") return "success";
  if (kind === "failed") return "error";
  if (kind === "stopping") return "warning";
  return "muted";
};

/** Keep the active tab visible when the complete strip cannot fit. Labels may contain ANSI. */
export const managerTabs = (tabs: ReadonlyArray<string>, active: number, width: number): string => {
  const full = `  ${tabs.join("  ")}`;
  return visibleWidth(full) <= width
    ? full
    : truncateToWidth(`  ${tabs[active] ?? ""}`, Math.max(0, width), "");
};

export type ManagerFooterGroup = string | undefined;

export const managerFooterLine = (groups: ReadonlyArray<ManagerFooterGroup>): string =>
  ` ${groups.filter((group): group is string => Boolean(group)).join(" │ ")} `;

/** Selects the first grouped footer variant that fits, then safely clips the narrow fallback. */
export const renderResponsiveManagerFooter = (
  contentWidth: number,
  variants: ReadonlyArray<ReadonlyArray<ManagerFooterGroup>>,
): string => {
  const safeWidth = Math.max(0, Math.floor(contentWidth));
  if (safeWidth === 0 || variants.length === 0) return "";
  const lines = variants.map(managerFooterLine);
  return (
    lines.find((line) => visibleWidth(line) <= safeWidth) ??
    truncateToWidth(lines.at(-1) ?? "", safeWidth, "")
  );
};
