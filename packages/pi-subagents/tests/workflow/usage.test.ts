// Explicit test entry-point Layer provision owns each scoped service runtime.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { SubagentUsage } from "../../src/run/model.ts";
import {
  controlForTask,
  deliveredFor,
  finished,
  journalLines,
  reportTask,
  runningTask,
  startScript,
  type WorkflowFixture,
  workflowTest,
} from "./fixtures/workflow-harness.ts";

const PAIR = `return await parallel([() => agent("first", { label: "a" }), () => agent("second", { label: "b" })]);`;

const usage = (input: number, output: number, cost?: number): SubagentUsage => ({
  input,
  output,
  cacheRead: 10,
  cacheWrite: 0,
  totalTokens: input + output + 10,
  ...(cost !== undefined && { cost }),
});

/** Has the running agent with `task` start `tools` tool calls and spend `spent`, then report. */
const work = (fixture: WorkflowFixture, task: string, spent: SubagentUsage, tools: number) =>
  Effect.gen(function* () {
    yield* runningTask(fixture, task);
    const control = yield* controlForTask(fixture, task);
    const assignmentEpoch = control.assignmentEpochs.at(-1) ?? 1;
    for (let index = 0; index < tools; index++)
      control.offer({
        type: "tool_started",
        assignmentEpoch,
        toolCallId: `${task}-${index}`,
        toolName: "read",
        args: { path: "src/a.ts" },
      });
    control.offer({ type: "usage", usage: spent });
    yield* reportTask(fixture, task, `${task} done`);
  });

describe("workflow usage", () => {
  it.live("adds up its live agents' usage and tool uses, and journals each agent's", () =>
    workflowTest({}, function* ({ fixture, workflows }) {
      const started = yield* startScript(workflows, PAIR);
      yield* work(fixture, "first", usage(100, 10, 0.5), 2);
      yield* work(fixture, "second", usage(200, 20, 0.25), 3);
      const run = yield* finished(workflows, started.id);
      expect(run.usage).toMatchObject({
        input: 300,
        output: 30,
        cacheRead: 20,
        totalTokens: 350,
        cost: 0.75,
        toolUses: 5,
        unpriced: 0,
      });
      const lines = journalLines(fixture.runFiles, run.journalPath);
      expect(lines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: "a",
            usage: { input: 100, output: 10, total: 120, cost: 0.5 },
            toolUses: 2,
            durationMs: expect.any(Number),
          }),
          expect.objectContaining({
            label: "b",
            usage: { input: 200, output: 20, total: 230, cost: 0.25 },
            toolUses: 3,
          }),
        ]),
      );
    }),
  );

  it.live("counts results a resume reuses without adding their earlier usage", () =>
    workflowTest({}, function* ({ fixture, workflows }) {
      const first = yield* startScript(workflows, PAIR);
      yield* work(fixture, "first", usage(100, 10, 0.5), 2);
      yield* work(fixture, "second", usage(200, 20), 3);
      const earlier = yield* finished(workflows, first.id);
      // One agent reported no cost, so the known cost is a lower bound.
      expect(earlier.usage).toMatchObject({ cost: 0.5, unpriced: 1 });

      const resumed = yield* startScript(workflows, PAIR, { resumeFromRunId: first.id });
      const run = yield* finished(workflows, resumed.id);
      expect(run.reused).toBe(2);
      expect(run.usage).toMatchObject({ totalTokens: 0, output: 0, toolUses: 0 });
      expect(run.usage.cost).toBeUndefined();
      const notification = yield* deliveredFor(fixture, resumed.id);
      expect(notification.usage).toEqual({ totalTokens: 0 });
    }),
  );
});
