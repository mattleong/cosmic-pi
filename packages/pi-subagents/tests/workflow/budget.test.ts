// Explicit test entry-point Layer provision owns each scoped service runtime.
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { WORKFLOW_BUDGET_REASON } from "../../src/workflow/budget.ts";
import { WORKFLOW_BUDGET_ERROR } from "../../src/workflow/prelude.ts";
import { emptyUsage } from "../../src/run/model.ts";
import type { WorkflowServiceContract } from "../../src/workflow/service.ts";
import {
  controlForTask,
  eventually,
  fakeNativeReportBackendLayer,
  finished,
  inline,
  journalLines,
  nativeReportRequest,
  reportTask,
  resultValue,
  runningTask,
  runWhere,
  script,
  stateOfTask,
  testHost,
  withWorkflows,
  workflowFixture,
} from "./fixtures/workflow-harness.ts";

/** Reports `output` tokens of live usage from the running agent with `task`. */
const spend = (fixture: ReturnType<typeof workflowFixture>, task: string, output: number) =>
  Effect.gen(function* () {
    yield* runningTask(fixture, task);
    const control = yield* controlForTask(fixture, task);
    control.offer({ type: "usage", usage: { ...emptyUsage(), output } });
  });

/** Waits until the run's agent labeled `label` runs, so the budget counts its live usage. */
const agentRunning = (workflows: WorkflowServiceContract, id: string, label: string) =>
  runWhere(workflows, id, (run) =>
    run.agents.some((agent) => agent.label === label && agent.state === "running"),
  );

/** Waits until the budget refused the run's queued agent labeled `label`. */
const refusedAgent = (workflows: WorkflowServiceContract, id: string, label: string) =>
  runWhere(workflows, id, (run) =>
    run.agents.some(
      (agent) =>
        agent.label === label &&
        agent.state === "skipped" &&
        agent.reason === WORKFLOW_BUDGET_REASON,
    ),
  );

describe("workflow token budget", () => {
  it.live("fails the run when an awaited agent() call is made after the budget is spent", () => {
    const fixture = workflowFixture();
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          {
            source: inline(`
              await agent("first");
              await agent("second");
              return "unreachable";`),
            args: null,
            budget: 100,
          },
          testHost(),
        );
        expect(started.budget).toEqual({ total: 100, spent: 0, refused: 0 });
        yield* spend(fixture, "first", 150);
        yield* reportTask(fixture, "first", "first done");
        const run = yield* finished(workflows, started.id);
        expect(run.state).toBe("failed");
        expect(run.failure).toMatchObject({
          name: WORKFLOW_BUDGET_ERROR,
          message: expect.stringContaining("budget"),
        });
        expect(run.budget).toEqual({ total: 100, spent: 150, refused: 1 });
        expect(run.warnings).toHaveLength(1);
        // A call made once the budget is spent never queues, so it has no view or agent.
        expect(run.agents).toHaveLength(1);
        expect(stateOfTask(fixture, "second")).toBeUndefined();
      }),
    );
  });

  it.live("lets the script catch the budget error and see the spent budget", () => {
    const fixture = workflowFixture();
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          {
            source: inline(`
              const first = await agent("first");
              try {
                await agent("second");
                return "unreachable";
              } catch (error) {
                if (error.name !== "${WORKFLOW_BUDGET_ERROR}") throw error;
                return { first, error: error.message, spent: budget.spent(), remaining: budget.remaining() };
              }`),
            args: null,
            budget: 100,
          },
          testHost(),
        );
        yield* spend(fixture, "first", 150);
        yield* reportTask(fixture, "first", "first done");
        const run = yield* finished(workflows, started.id);
        expect(run.state).toBe("completed");
        expect(resultValue(run)).toEqual({
          first: "first done",
          error: expect.stringContaining("budget"),
          spent: 150,
          remaining: 0,
        });
        expect(run.budget).toEqual({ total: 100, spent: 150, refused: 1 });
      }),
    );
  });

  it.live("turns refused calls inside parallel() and pipeline() into null with one warning", () => {
    const fixture = workflowFixture();
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          {
            source: inline(`
              const first = await agent("first");
              const fanned = await parallel(["a", "b", "c"].map((task) => () => agent(task)));
              const piped = await pipeline([1, 2], (n) => agent("stage " + n), (found) => "next " + found);
              return { first, fanned, piped };`),
            args: null,
            budget: 100,
          },
          testHost(),
        );
        yield* spend(fixture, "first", 150);
        yield* reportTask(fixture, "first", "first done");
        const run = yield* finished(workflows, started.id);
        // A budget error isn't an invalid call, which would fail the run even inside them.
        expect(run.state).toBe("completed");
        expect(resultValue(run)).toEqual({
          first: "first done",
          fanned: [null, null, null],
          piped: [null, null],
        });
        expect(run.budget).toEqual({ total: 100, spent: 150, refused: 5 });
        expect(run.warnings).toHaveLength(1);
      }),
    );
  });

  it.live("ends a sequential loop guarded by budget.remaining() without a budget error", () => {
    const fixture = workflowFixture();
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          {
            source: inline(`
              const done = [];
              while (budget.total && budget.remaining() > 0) done.push(await agent("step " + done.length));
              return { done, spent: budget.spent() };`),
            args: null,
            budget: 100,
          },
          testHost(),
        );
        yield* spend(fixture, "step 0", 60);
        yield* reportTask(fixture, "step 0", "step 0 done");
        yield* spend(fixture, "step 1", 60);
        yield* reportTask(fixture, "step 1", "step 1 done");
        const run = yield* finished(workflows, started.id);
        expect(run.state).toBe("completed");
        expect(resultValue(run)).toEqual({ done: ["step 0 done", "step 1 done"], spent: 120 });
        expect(run.budget).toEqual({ total: 100, spent: 120, refused: 0 });
        expect(run.warnings ?? []).toEqual([]);
      }),
    );
  });

  it.live(
    "counts what subagents a workflow agent starts itself spend, in budget.spent() too",
    () => {
      const fixture = workflowFixture();
      return withWorkflows(fixture, (workflows, subagents) =>
        Effect.gen(function* () {
          const started = yield* workflows.start(
            {
              source: inline(`
              const first = await agent("delegate");
              const second = budget.remaining() > 0 ? await agent("second") : "over budget";
              return { first, second, spent: budget.spent() };`),
              args: null,
              budget: 100,
            },
            testHost(),
          );
          const parentRunId = yield* runningTask(fixture, "delegate");
          yield* subagents.start(
            nativeReportRequest({ name: "helper", task: "helper", parentRunId }),
          );
          yield* spend(fixture, "helper", 150);
          yield* reportTask(fixture, "delegate", "delegated");
          const run = yield* finished(workflows, started.id);
          expect(resultValue(run)).toEqual({
            first: "delegated",
            second: "over budget",
            spent: 150,
          });
          expect(run.budget).toEqual({ total: 100, spent: 150, refused: 0 });
          expect(run.usage.output).toBe(150);
          expect(journalLines(fixture.runFiles, run.journalPath)[0]).toMatchObject({
            label: "agent-1",
            outputTokens: 150,
          });
        }),
      );
    },
  );

  it.live("counts refused calls toward the agent limit, which ends a catch-all retry loop", () => {
    const fixture = workflowFixture();
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        // The catch swallows the limit's error too, so only the host can end this loop.
        const started = yield* workflows.start(
          {
            source: inline(`
              const found = [];
              let attempt = 0;
              while (found.length < 3) {
                try {
                  const result = await agent("more " + attempt++);
                  if (result) found.push(result);
                } catch {}
              }
              return found;`),
            args: null,
            budget: 100,
          },
          testHost(),
        );
        yield* spend(fixture, "more 0", 150);
        yield* reportTask(fixture, "more 0", "first");
        const run = yield* finished(workflows, started.id);
        expect(run.state).toBe("failed");
        expect(run.failure?.message).toContain("at most 1000 agents");
        expect(run.budget).toEqual({ total: 100, spent: 150, refused: 999 });
      }),
    );
  });

  it.live("rejects a queued call the budget refuses and keeps its row", () => {
    const fixture = workflowFixture({ concurrency: 1 });
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          {
            source: inline(`
              const first = agent("a", { label: "a" });
              let refused;
              try {
                await agent("b", { label: "b" });
              } catch (error) {
                refused = error.message;
              }
              return { a: await first, refused };`),
            args: null,
            budget: 100,
          },
          testHost(),
        );
        yield* agentRunning(workflows, started.id, "a");
        // "b" waits for the run's only slot, which "a" holds.
        yield* runWhere(workflows, started.id, (run) =>
          run.agents.some((agent) => agent.label === "b" && agent.waiting?.kind === "slot"),
        );
        yield* spend(fixture, "a", 150);
        const refused = yield* refusedAgent(workflows, started.id, "b");
        expect(refused.budget).toMatchObject({ spent: 150, refused: 1 });
        expect(stateOfTask(fixture, "a")).toBe("running");

        yield* reportTask(fixture, "a", "a done");
        const run = yield* finished(workflows, started.id);
        expect(run.state).toBe("completed");
        expect(resultValue(run)).toEqual({
          a: "a done",
          refused: expect.stringContaining("budget"),
        });
        expect(run.agents.find((agent) => agent.label === "b")).toMatchObject({
          state: "skipped",
          reason: WORKFLOW_BUDGET_REASON,
        });
        expect(stateOfTask(fixture, "b")).toBeUndefined();
        expect(run.warnings).toHaveLength(1);
      }),
    );
  });

  it.live(
    "refuses queued calls once running agents' live usage reaches it, without stopping them",
    () => {
      const fixture = workflowFixture({ concurrency: 2 });
      return withWorkflows(fixture, (workflows) =>
        Effect.gen(function* () {
          const started = yield* workflows.start(
            {
              source: inline(
                'return await parallel(["a", "b", "c"].map((task) => () => agent(task, { label: task })));',
              ),
              args: null,
              budget: 100,
            },
            testHost(),
          );
          yield* runningTask(fixture, "b");
          yield* agentRunning(workflows, started.id, "a");
          // The view follows running agents' live usage before the ceiling.
          yield* spend(fixture, "a", 50);
          const live = yield* runWhere(workflows, started.id, (run) => run.budget?.spent === 50);
          expect(live.budget?.refused).toBe(0);
          // "c" waits for a run slot; "a" spends the rest of the budget while it is still running.
          yield* spend(fixture, "a", 100);
          const refused = yield* runWhere(workflows, started.id, (run) =>
            run.agents.some((agent) => agent.label === "c" && agent.state === "skipped"),
          );
          expect(refused.agents.find((agent) => agent.label === "c")).toMatchObject({
            reason: "budget exhausted",
          });
          expect(refused.budget).toMatchObject({ spent: 150, refused: 1 });
          expect(stateOfTask(fixture, "a")).toBe("running");
          expect(stateOfTask(fixture, "b")).toBe("running");
          expect(stateOfTask(fixture, "c")).toBeUndefined();

          yield* reportTask(fixture, "a", "a done");
          yield* reportTask(fixture, "b", "b done");
          const run = yield* finished(workflows, started.id);
          expect(resultValue(run)).toEqual(["a done", "b done", null]);
          expect(run.budget).toEqual({ total: 100, spent: 150, refused: 1 });
          expect(run.warnings).toHaveLength(1);
        }),
      );
    },
  );

  it.live("gives up a start still under way once the budget runs out", () => {
    const initialized = Deferred.makeUnsafe<void>();
    const mayStart = Deferred.makeUnsafe<void>();
    const fixture = workflowFixture({
      concurrency: 2,
      // "held" gets the first process, which stays initializing; "a" starts after it.
      backend: fakeNativeReportBackendLayer({ initializeGate: initialized }),
      decorate: (service) => ({
        ...service,
        startOwned: (request, owner) =>
          request.task === "a"
            ? Deferred.await(mayStart).pipe(Effect.andThen(service.startOwned(request, owner)))
            : service.startOwned(request, owner),
      }),
    });
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          {
            source: inline(
              'return await parallel(["held", "a"].map((task) => () => agent(task, { label: task })));',
            ),
            args: null,
            budget: 100,
          },
          testHost(),
        );
        yield* eventually(
          () => (fixture.backend.controls.length === 1 ? true : undefined),
          `the "held" agent's process`,
        );
        yield* Deferred.succeed(mayStart, undefined);
        yield* agentRunning(workflows, started.id, "a");
        yield* spend(fixture, "a", 150);
        const refused = yield* refusedAgent(workflows, started.id, "held");
        expect(refused.budget).toMatchObject({ spent: 150, refused: 1 });
        // Its start was interrupted, which stopped the agent before it ran.
        yield* eventually(
          () => (stateOfTask(fixture, "held") === "stopped" ? true : undefined),
          `the "held" agent to stop`,
        );
        expect(stateOfTask(fixture, "a")).toBe("running");

        yield* reportTask(fixture, "a", "a done");
        const run = yield* finished(workflows, started.id);
        expect(resultValue(run)).toEqual([null, "a done"]);
        expect(run.warnings).toHaveLength(1);
      }),
    );
  });

  it.live("refuses a call waiting behind a writer once the budget runs out", () => {
    const fixture = workflowFixture({ concurrency: 2 });
    const files = ["x.ts", "y.ts"];
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          {
            source: inline(
              'return await parallel(["x.ts", "y.ts"].map((file) => () => agent("Edit " + file, { profile: "worker", label: file })));',
            ),
            args: null,
            budget: 100,
          },
          testHost(),
        );
        // Either writer may start first; the other waits behind it.
        const queued = yield* runWhere(workflows, started.id, (run) =>
          run.agents.some((agent) => agent.waiting?.kind === "writer"),
        );
        const waiting = queued.agents.find((agent) => agent.waiting?.kind === "writer")!.label;
        const writer = files.find((file) => file !== waiting)!;
        yield* agentRunning(workflows, started.id, writer);
        yield* spend(fixture, `Edit ${writer}`, 150);
        const refused = yield* refusedAgent(workflows, started.id, waiting);
        expect(refused.budget).toMatchObject({ spent: 150, refused: 1 });
        expect(stateOfTask(fixture, `Edit ${waiting}`)).toBeUndefined();

        yield* reportTask(fixture, `Edit ${writer}`, `${writer} edited`);
        const run = yield* finished(workflows, started.id);
        expect(run.budget?.refused).toBe(1);
        expect(run.warnings).toHaveLength(1);
      }),
    );
  });

  it.live("counts what a stopped run's agents spent in its total and results journal", () => {
    const fixture = workflowFixture();
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          { source: inline('return await agent("a", { label: "a" });'), args: null, budget: 100 },
          testHost(),
        );
        yield* agentRunning(workflows, started.id, "a");
        yield* spend(fixture, "a", 30);
        yield* runWhere(workflows, started.id, (run) => run.budget?.spent === 30);
        yield* workflows.stop(started.id);
        const run = yield* finished(workflows, started.id);
        expect(run.state).toBe("stopped");
        expect(run.budget?.spent).toBe(30);
        expect(run.usage.output).toBe(30);
        expect(journalLines(fixture.runFiles, run.journalPath)).toEqual([
          expect.objectContaining({ label: "a", state: "stopped", outputTokens: 30 }),
        ]);
      }),
    );
  });

  it.live("shares the budget with a nested workflow", () => {
    const fixture = workflowFixture({
      scripts: {
        child: script(
          'let inner; try { inner = await agent("inner") } catch { inner = "refused" } return { inner, spent: budget.spent(), total: budget.total };',
          "child",
        ),
      },
    });
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          {
            source: inline(
              'const outer = await agent("outer"); return { outer, child: await workflow("child") };',
            ),
            args: null,
            budget: 100,
          },
          testHost(),
        );
        yield* spend(fixture, "outer", 150);
        yield* reportTask(fixture, "outer", "outer done");
        const run = yield* finished(workflows, started.id);
        expect(resultValue(run)).toEqual({
          outer: "outer done",
          child: { inner: "refused", spent: 150, total: 100 },
        });
        expect(run.budget?.refused).toBe(1);
      }),
    );
  });

  it.live("doesn't count results reused from the resumed run", () => {
    const fixture = workflowFixture();
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const earlier = yield* workflows.start(
          { source: inline('return await agent("first");'), args: null },
          testHost(),
        );
        expect(earlier.budget).toBeUndefined();
        yield* spend(fixture, "first", 150);
        yield* reportTask(fixture, "first", "first done");
        yield* finished(workflows, earlier.id);

        const resumed = yield* workflows.start(
          {
            source: inline(`
              const first = await agent("first");
              const afterReuse = budget.spent();
              const second = await agent("second");
              return { first, afterReuse, second };`),
            args: null,
            resumeFromRunId: earlier.id,
            budget: 100,
          },
          testHost(),
        );
        yield* reportTask(fixture, "second", "second done");
        const run = yield* finished(workflows, resumed.id);
        expect(resultValue(run)).toEqual({
          first: "first done",
          afterReuse: 0,
          second: "second done",
        });
        expect(run.budget).toEqual({ total: 100, spent: 0, refused: 0 });
      }),
    );
  });
});
