import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const BRAILLE_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const STARTING_SPINNER_FRAMES = ["◌", "◔", "◑", "◕"] as const;

const frameAt = (frames: ReadonlyArray<string>, frame: number, fallback: string): string =>
  frames[Math.abs(Math.floor(frame)) % frames.length] ?? fallback;

export const brailleSpinnerFrame = (frame: number): string =>
  frameAt(BRAILLE_SPINNER_FRAMES, frame, "⠋");

export const startingSpinnerFrame = (frame: number): string =>
  frameAt(STARTING_SPINNER_FRAMES, frame, "◌");

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
