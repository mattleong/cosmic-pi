import type { PageSteps } from "./keymap.ts";

/** Motion keybindings shared by settings list pages; endpoint motions jump to the bounds. */
export type ListMotion =
  | "up"
  | "down"
  | "half-page-up"
  | "half-page-down"
  | "full-page-up"
  | "full-page-down"
  | "first"
  | "last";

/** One-row and page motions that shift the selection by a signed offset. */
export type MovementMotion = Exclude<ListMotion, "first" | "last">;

const MOVEMENT_MOTIONS: ReadonlySet<string> = new Set([
  "up",
  "down",
  "half-page-up",
  "half-page-down",
  "full-page-up",
  "full-page-down",
]);

export const isListMotion = (action: string): action is ListMotion =>
  action === "first" || action === "last" || MOVEMENT_MOTIONS.has(action);

export const isMovementMotion = (action: string): action is MovementMotion =>
  MOVEMENT_MOTIONS.has(action);

/** Signed row offset for a movement motion under the given page steps. */
export const movementOffset = (motion: MovementMotion, steps: PageSteps): number => {
  if (motion === "up") return -1;
  if (motion === "down") return 1;
  if (motion === "half-page-up") return -steps.half;
  if (motion === "half-page-down") return steps.half;
  if (motion === "full-page-up") return -steps.page;
  return steps.page;
};

/** Pure clamped arithmetic for one list motion; single-row motions may wrap when allowed. */
export const nextListMotionIndex = (
  motion: ListMotion,
  current: number,
  length: number,
  steps: PageSteps,
  wrapSingleRow = false,
): number => {
  const last = Math.max(0, length - 1);
  switch (motion) {
    case "up":
      return wrapSingleRow
        ? (current - 1 + length) % length
        : Math.max(0, Math.min(last, current - 1));
    case "down":
      return wrapSingleRow ? (current + 1) % length : Math.max(0, Math.min(last, current + 1));
    case "half-page-up":
      return Math.max(0, Math.min(last, current - steps.half));
    case "half-page-down":
      return Math.max(0, Math.min(last, current + steps.half));
    case "full-page-up":
      return Math.max(0, Math.min(last, current - steps.page));
    case "full-page-down":
      return Math.max(0, Math.min(last, current + steps.page));
    case "first":
      return 0;
    case "last":
      return last;
  }
};
