import * as Effect from "effect/Effect";
import { invalidRequest } from "./errors.ts";
import type { RunRecord } from "./internal.ts";
import type { SubagentControlExpectation } from "./model.ts";

// Check captured UI authority at the same locked boundary that admits the control.
export const requireControlExpectation = (
  record: RunRecord,
  expected: SubagentControlExpectation | undefined,
) =>
  expected === undefined ||
  (record.assignment.epoch === expected.assignmentEpoch &&
    record.view.sessionId === expected.sessionId &&
    record.view.state === expected.state &&
    record.view.question?.requestId === expected.questionRequestId)
    ? Effect.void
    : Effect.fail(
        invalidRequest(
          "run_control_changed",
          "This subagent changed before the action could start. Check its current state in Activity and try again.",
        ),
      );
