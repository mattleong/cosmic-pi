// Explicit test entry-point Layer provision owns each scoped service runtime.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { WorkflowRunObserver } from "../../src/workflow/run-observer.ts";
import {
  eventually,
  finished,
  inWorkflows,
  memoryRunFiles,
  runningTask,
  startScript,
  withWorkflows,
  workflowFixture,
  workflowSessionKey,
  workflowTest,
  until,
} from "./fixtures/workflow-harness.ts";

/** Records what the observer hears, as `opened <id>` and `closed <id> <handoff>`. */
const recordingObserver = () => {
  const events: string[] = [];
  const observer: WorkflowRunObserver = {
    opened: (runId) => events.push(`opened ${runId}`),
    closed: (runId, handoff) => events.push(`closed ${runId} ${handoff}`),
  };
  return { events, observer };
};

describe("workflow run observer", () => {
  it.live("opens a run at start and closes it once Pi accepts its notification", () => {
    const { events, observer } = recordingObserver();
    let accept = false;
    return workflowTest({ observer, accept: () => accept }, function* ({ fixture, workflows }) {
      const started = yield* startScript(workflows, "return 1;");
      yield* finished(workflows, started.id);
      yield* eventually(() => fixture.workflowNotifications[0], "the refused notification");
      // The run stays open while its notification waits to be accepted.
      expect(events).toEqual([`opened ${started.id}`]);
      accept = true;
      yield* eventually(() => fixture.delivered[0], "the accepted notification");
      // The result wakes the main agent, so the agent run it joins or starts handles it.
      yield* until(() => events.includes(`closed ${started.id} now`), "the run to close");
    });
  });

  it.live("hands a run the user stopped to the next turn", () => {
    const { events, observer } = recordingObserver();
    return workflowTest({ observer }, function* ({ fixture, workflows }) {
      const started = yield* startScript(workflows, 'return await agent("long");');
      yield* runningTask(fixture, "long");
      yield* workflows.stop(started.id, "user");
      yield* until(
        () => events.includes(`closed ${started.id} next-turn`),
        "the stopped run to close",
      );
    });
  });

  it.live("closes a run the main agent stopped, which needs no notification", () => {
    const { events, observer } = recordingObserver();
    return workflowTest({ observer }, function* ({ fixture, workflows }) {
      const started = yield* startScript(workflows, 'return await agent("long");');
      yield* runningTask(fixture, "long");
      const stopped = yield* workflows.stop(started.id, "tool");
      expect(stopped).toMatchObject({ state: "stopped", stoppedBy: "tool" });
      expect(events).toEqual([`opened ${started.id}`, `closed ${started.id} now`]);
      // Let any delivery fiber run before checking that none was started.
      yield* Effect.sleep("50 millis");
      expect(fixture.workflowNotifications).toEqual([]);
    });
  });

  it.live("reopens a run a reload interrupted when its notice is posted", () => {
    const sessionKey = workflowSessionKey();
    const runFiles = memoryRunFiles();
    const first = workflowFixture({ sessionKey, runFiles, accept: () => false });
    return Effect.gen(function* () {
      const runId = yield* inWorkflows(first, function* ({ workflows }) {
        const started = yield* startScript(workflows, "return 1;");
        yield* finished(workflows, started.id);
        yield* eventually(() => first.workflowNotifications[0], "the refused notification");
        return started.id;
      });
      const { events, observer } = recordingObserver();
      const reloaded = workflowFixture({ sessionKey, runFiles, observer });
      yield* withWorkflows(reloaded, () =>
        until(() => events.includes(`closed ${runId} next-turn`), "the notice to be accepted"),
      );
      // The notice waits for the next turn, so the next agent run handles it.
      expect(events).toEqual([`opened ${runId}`, `closed ${runId} next-turn`]);
      expect(reloaded.delivered).toEqual([
        expect.objectContaining({ runId, outcome: "interrupted" }),
      ]);
    });
  });
});
