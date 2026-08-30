import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { SubagentProcessError, type SubagentError } from "../run/errors.ts";

export type LocalCliInterruptOwnership = "release" | "retain";

/**
 * Classifies whether an interrupted native control call must retain its correlated lifecycle.
 * Typed uncertainty and interruption keep ownership; success and definite failure release it.
 */
export const classifyLocalCliInterruptOwnership = <A>(
  exit: Exit.Exit<A, SubagentError>,
): LocalCliInterruptOwnership => {
  if (Exit.isSuccess(exit)) return "release";
  if (Cause.hasInterruptsOnly(exit.cause)) return "retain";
  const error = Cause.findErrorOption(exit.cause);
  return Option.isSome(error) &&
    error.value instanceof SubagentProcessError &&
    error.value.code === "interrupt_outcome_uncertain"
    ? "retain"
    : "release";
};
