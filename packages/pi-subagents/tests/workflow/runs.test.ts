import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import type { WorkflowRunView } from "../../src/workflow/model.ts";
import {
  makeWorkflowRuns,
  WORKFLOW_ACTIVITY_PUBLISH_MS,
  type WorkflowActivitySink,
} from "../../src/workflow/runs.ts";
import { workflowRunView } from "../fixtures/run-view.ts";
import {
  eventually,
  finished,
  script,
  testHost,
  withWorkflows,
  workflowFixture,
} from "./fixtures/workflow-harness.ts";

const run = (id = "wf-a-1"): WorkflowRunView => workflowRunView({ id });

/** Records what reaches the host: every published snapshot. */
const recordingSink = () => {
  const published: Array<ReadonlyArray<WorkflowRunView>> = [];
  const sink: WorkflowActivitySink = { publish: (runs) => void published.push(runs) };
  return { sink, published };
};

describe("workflow run views in Activity", () => {
  it.effect("coalesces a burst of log lines and publishes starts and finishes at once", () =>
    Effect.gen(function* () {
      const host = recordingSink();
      const scope = yield* Scope.make();
      const runs = yield* makeWorkflowRuns(host.sink).pipe(Scope.provide(scope));
      yield* runs.mutate((views) => [...views, run()]);
      // A start publishes before any time passes.
      expect(host.published).toHaveLength(1);
      for (let line = 0; line < 2_000; line++)
        yield* runs.recordEvent("wf-a-1", { type: "log", message: `line ${line}` });
      // The lines are held back; nothing republished yet.
      expect(host.published).toHaveLength(1);
      yield* TestClock.adjust(WORKFLOW_ACTIVITY_PUBLISH_MS);
      expect(host.published).toHaveLength(2);
      expect(host.published.at(-1)?.[0]?.lastLog).toBe("line 1999");
      // A quiet store publishes nothing more.
      yield* TestClock.adjust(WORKFLOW_ACTIVITY_PUBLISH_MS * 4);
      expect(host.published).toHaveLength(2);
      // Lines still held back go out with the stop, which publishes at once.
      yield* runs.recordEvent("wf-a-1", { type: "log", message: "stopping now" });
      yield* runs.update("wf-a-1", (view) => ({ ...view, state: "stopping" }));
      expect(host.published).toHaveLength(3);
      expect(host.published.at(-1)?.[0]).toMatchObject({
        state: "stopping",
        lastLog: "stopping now",
      });
      yield* runs.update("wf-a-1", (view) => ({ ...view, state: "stopped", endedAt: 9 }));
      expect(host.published).toHaveLength(4);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("publishes nothing once its scope closes", () =>
    Effect.gen(function* () {
      const host = recordingSink();
      const scope = yield* Scope.make();
      const runs = yield* makeWorkflowRuns(host.sink).pipe(Scope.provide(scope));
      yield* runs.mutate((views) => [...views, run()]);
      yield* runs.recordEvent("wf-a-1", { type: "log", message: "held back" });
      yield* Scope.close(scope, Exit.void);
      yield* runs.recordEvent("wf-a-1", { type: "log", message: "after close" });
      yield* runs.mutate((views) => [...views, run("wf-a-2")]);
      yield* TestClock.adjust(WORKFLOW_ACTIVITY_PUBLISH_MS * 2);
      expect(host.published).toHaveLength(1);
      // The views themselves still change for status.
      expect((yield* runs.list).map((view) => view.id)).toEqual(["wf-a-1", "wf-a-2"]);
    }),
  );
  it.live("publishes a script's log burst far fewer times than it logs", () => {
    const host = recordingSink();
    const fixture = workflowFixture({ activity: host.sink });
    const lines = 2_000;
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          {
            source: {
              kind: "inline",
              script: script(
                `for (let line = 0; line < ${lines}; line++) log("line " + line); return 1;`,
              ),
            },
            args: null,
          },
          testHost(),
        );
        // The start is in Activity before the script logs anything.
        expect(host.published[0]?.map((view) => view.id)).toEqual([started.id]);
        yield* finished(workflows, started.id);
        yield* eventually(
          () =>
            host.published.at(-1)?.find((view) => view.id === started.id)?.state === "completed"
              ? true
              : undefined,
          "the finished run in Activity",
        );
        expect(host.published.length).toBeLessThan(lines / 10);
      }),
    );
  });
});
