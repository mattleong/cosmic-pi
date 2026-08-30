import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import { describe, expect, it } from "vitest";
import { classifyLocalCliInterruptOwnership } from "../src/backend/local-cli-interruption.ts";
import { SubagentProcessError } from "../src/run/errors.ts";

const processFailure = (code: string) =>
  new SubagentProcessError({
    operation: "interrupt",
    code,
    message: code,
  });

describe("local CLI interruption ownership", () => {
  it("retains interruption-only exits", () => {
    expect(classifyLocalCliInterruptOwnership(Exit.interrupt(1))).toBe("retain");
    expect(
      classifyLocalCliInterruptOwnership(
        Exit.failCause(
          Cause.fromReasons([Cause.makeInterruptReason(1), Cause.makeInterruptReason(2)]),
        ),
      ),
    ).toBe("retain");
  });

  it("retains typed uncertain outcomes, including mixed interruption causes", () => {
    const uncertain = processFailure("interrupt_outcome_uncertain");
    expect(classifyLocalCliInterruptOwnership(Exit.fail(uncertain))).toBe("retain");
    expect(
      classifyLocalCliInterruptOwnership(
        Exit.failCause(
          Cause.fromReasons([
            Cause.makeInterruptReason(1),
            Cause.makeFailReason(processFailure("interrupt_outcome_uncertain")),
          ]),
        ),
      ),
    ).toBe("retain");
  });

  it("releases success, definite failures, and defects", () => {
    expect(classifyLocalCliInterruptOwnership(Exit.succeed(undefined))).toBe("release");
    expect(
      classifyLocalCliInterruptOwnership(Exit.fail(processFailure("interrupt_rejected"))),
    ).toBe("release");
    expect(
      classifyLocalCliInterruptOwnership(
        Exit.die({ _tag: "SubagentProcessError", code: "interrupt_outcome_uncertain" }),
      ),
    ).toBe("release");
  });
});
