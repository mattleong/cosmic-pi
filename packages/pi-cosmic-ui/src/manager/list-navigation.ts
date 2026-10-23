import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import type { PageSteps } from "./keymap.ts";

const MOVEMENT_OFFSETS = {
  up: () => -1,
  down: () => 1,
  "half-page-up": (steps: PageSteps) => -steps.half,
  "half-page-down": (steps: PageSteps) => steps.half,
  "full-page-up": (steps: PageSteps) => -steps.page,
  "full-page-down": (steps: PageSteps) => steps.page,
};

type MovementMotion = keyof typeof MOVEMENT_OFFSETS;
const MOVEMENT_MOTIONS = Struct.keys(MOVEMENT_OFFSETS);

const ListMotionSchema = Schema.Literals([...MOVEMENT_MOTIONS, "first", "last"]);
export type ListMotion = typeof ListMotionSchema.Type;

export const isMovementMotion = Schema.is(Schema.Literals(MOVEMENT_MOTIONS));

export const isListMotion = Schema.is(ListMotionSchema);

export const movementOffset = (motion: MovementMotion, steps: PageSteps): number =>
  MOVEMENT_OFFSETS[motion](steps);

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
