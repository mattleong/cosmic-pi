import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import { describe, expect, it } from "vitest";
import { classifyLocalCliInterruptOwnership } from "../src/backend/local-cli-interruption.ts";
import { SubagentProcessError, type SubagentError } from "../src/run/errors.ts";

const processFailure = (code: string) =>
  new SubagentProcessError({
    operation: "interrupt",
    code,
    message: code,
  });

const uncertain = processFailure("interrupt_outcome_uncertain");

describe("local CLI interruption ownership", () => {
  it.each<[string, "retain" | "release", Exit.Exit<unknown, SubagentError>]>([
    ["an interruption-only exit", "retain", Exit.interrupt(1)],
    [
      "a multi-fiber interruption",
      "retain",
      Exit.failCause(
        Cause.fromReasons([Cause.makeInterruptReason(1), Cause.makeInterruptReason(2)]),
      ),
    ],
    ["a typed uncertain outcome", "retain", Exit.fail(uncertain)],
    [
      "an uncertain outcome mixed with interruption",
      "retain",
      Exit.failCause(
        Cause.fromReasons([Cause.makeInterruptReason(1), Cause.makeFailReason(uncertain)]),
      ),
    ],
    ["success", "release", Exit.succeed(undefined)],
    ["a definite failure", "release", Exit.fail(processFailure("interrupt_rejected"))],
    [
      "a defect shaped like an uncertain failure",
      "release",
      Exit.die({ _tag: "SubagentProcessError", code: "interrupt_outcome_uncertain" }),
    ],
  ])("classifies %s as %s", (_label, ownership, exit) => {
    expect(classifyLocalCliInterruptOwnership(exit)).toBe(ownership);
  });
});
