import { describe, expect, it } from "@effect/vitest";
import type { WorkflowAgentAttention, WorkflowViewStatus } from "../../src/workflow/attention.ts";
import type { WorkflowRunView } from "../../src/workflow/model.ts";
import { makeWorkflowStatusRepeats } from "../../src/workflow/status-repeat.ts";
import { workflowAgentView, workflowRunView } from "../fixtures/run-view.ts";

const question: WorkflowAgentAttention = {
  kind: "question",
  message: "Which module?",
  runId: "agent-r1-1",
  writer: false,
};

const statusOf = (
  run: WorkflowRunView,
  attention: ReadonlyArray<WorkflowAgentAttention> = [],
): WorkflowViewStatus => ({ kind: "view", run, attention });

describe("workflow status repeats", () => {
  it("never shortens a repeat while an agent waits on a person", () => {
    const repeats = makeWorkflowStatusRepeats();
    // A question leaves the agent running, so its state and counts don't change.
    const asking = workflowRunView({
      agents: [workflowAgentView({ state: "running", startedAt: 3 })],
    });
    expect(repeats.note(statusOf(asking, [question]), 1_000)).toBeUndefined();
    expect(repeats.note(statusOf(asking, [question]), 2_000)).toBeUndefined();
    // Once answered, the first call is full and the next repeat is short.
    expect(repeats.note(statusOf(asking), 3_000)).toBeUndefined();
    expect(repeats.note(statusOf(asking), 4_000)).toBe(1_000);
  });

  it("never shortens a repeat while an agent queues behind a paused writer", () => {
    const behindWriter = (paused: boolean) =>
      workflowRunView({
        agents: [
          workflowAgentView({
            waiting: { kind: "writer", runId: "agent-w", name: "writer", paused },
          }),
        ],
      });
    const paused = makeWorkflowStatusRepeats();
    expect(paused.note(statusOf(behindWriter(true)), 1_000)).toBeUndefined();
    expect(paused.note(statusOf(behindWriter(true)), 2_000)).toBeUndefined();
    // Queued behind a writer that is merely busy, a repeat is short.
    const busy = makeWorkflowStatusRepeats();
    expect(busy.note(statusOf(behindWriter(false)), 1_000)).toBeUndefined();
    expect(busy.note(statusOf(behindWriter(false)), 2_000)).toBe(1_000);
  });
});
