import type { PageSteps } from "./keymap.ts";

/** Signed row offset of each one-row and page motion under the given page steps. */
const MOVEMENT_OFFSETS = {
  up: () => -1,
  down: () => 1,
  "half-page-up": (steps: PageSteps) => -steps.half,
  "half-page-down": (steps: PageSteps) => steps.half,
  "full-page-up": (steps: PageSteps) => -steps.page,
  "full-page-down": (steps: PageSteps) => steps.page,
};

/** One-row and page motions that shift the selection by a signed offset. */
type MovementMotion = keyof typeof MOVEMENT_OFFSETS;

/** Motion keybindings shared by settings list pages; endpoint motions jump to the bounds. */
export type ListMotion = MovementMotion | "first" | "last";

export const isMovementMotion = (action: string): action is MovementMotion =>
  Object.hasOwn(MOVEMENT_OFFSETS, action);

export const isListMotion = (action: string): action is ListMotion =>
  action === "first" || action === "last" || isMovementMotion(action);

/** Signed row offset for a movement motion under the given page steps. */
export const movementOffset = (motion: MovementMotion, steps: PageSteps): number =>
  MOVEMENT_OFFSETS[motion](steps);

/** Pure clamped arithmetic for one list motion; single-row motions may wrap when allowed. */
export const nextListMotionIndex = (
  motion: ListMotion,
  current: number,
  length: number,
  steps: PageSteps,
  wrapSingleRow = false,
): number => {
  const last = Math.max(0, length - 1);
  if (isMovementMotion(motion)) {
    const next = current + movementOffset(motion, steps);
    if (wrapSingleRow && motion === "up") return (next + length) % length;
    if (wrapSingleRow && motion === "down") return next % length;
    return Math.max(0, Math.min(last, next));
  }
  return motion === "first" ? 0 : last;
};
