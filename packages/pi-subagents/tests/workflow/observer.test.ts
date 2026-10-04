// Explicit test entry-point Layer provision owns each scoped service runtime.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { WorkflowRunObserver } from "../../src/workflow/run-observer.ts";
import {
  eventually,
  finished,
  inline,
  memoryRunFiles,
  runningTask,
  testHost,
  withWorkflows,
  workflowFixture,
  workflowSessionKey,
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
    const fixture = workflowFixture({ observer, accept: () => accept });
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          { source: inline("return 1;"), args: null },
          testHost(),
        );
        yield* finished(workflows, started.id);
        yield* eventually(() => fixture.workflowNotifications[0], "the refused notification");
        // The run stays open while its notification waits to be accepted.
        expect(events).toEqual([`opened ${started.id}`]);
        accept = true;
        yield* eventually(() => fixture.delivered[0], "the accepted notification");
        // The result wakes the main agent, so the agent run it joins or starts handles it.
        yield* eventually(
          () => (events.includes(`closed ${started.id} now`) ? true : undefined),
          "the run to close",
        );
      }),
    );
  });

  it.live("hands a run the user stopped to the next turn", () => {
    const { events, observer } = recordingObserver();
    const fixture = workflowFixture({ observer });
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          { source: inline('return await agent("long");'), args: null },
          testHost(),
        );
        yield* runningTask(fixture, "long");
        yield* workflows.stop(started.id, "user");
        yield* eventually(
          () => (events.includes(`closed ${started.id} next-turn`) ? true : undefined),
          "the stopped run to close",
        );
      }),
    );
  });

  it.live("closes a run the main agent stopped, which needs no notification", () => {
    const { events, observer } = recordingObserver();
    const fixture = workflowFixture({ observer });
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          { source: inline('return await agent("long");'), args: null },
          testHost(),
        );
        yield* runningTask(fixture, "long");
        yield* workflows.stop(started.id, "tool");
        expect(events).toEqual([`opened ${started.id}`, `closed ${started.id} now`]);
      }),
    );
  });

  it.live("reopens a run a reload interrupted when its notice is posted", () => {
    const sessionKey = workflowSessionKey();
    const runFiles = memoryRunFiles();
    const first = workflowFixture({ sessionKey, runFiles, accept: () => false });
    return Effect.gen(function* () {
      const runId = yield* withWorkflows(first, (workflows) =>
        Effect.gen(function* () {
          const started = yield* workflows.start(
            { source: inline("return 1;"), args: null },
            testHost(),
          );
          yield* finished(workflows, started.id);
          yield* eventually(() => first.workflowNotifications[0], "the refused notification");
          return started.id;
        }),
      );
      const { events, observer } = recordingObserver();
      const reloaded = workflowFixture({ sessionKey, runFiles, observer });
      yield* withWorkflows(reloaded, () =>
        eventually(
          () => (events.includes(`closed ${runId} next-turn`) ? true : undefined),
          "the notice to be accepted",
        ),
      );
      // The notice waits for the next turn, so the next agent run handles it.
      expect(events).toEqual([`opened ${runId}`, `closed ${runId} next-turn`]);
      expect(reloaded.delivered).toEqual([
        expect.objectContaining({ runId, outcome: "interrupted" }),
      ]);
    });
  });
});
