// Explicit test entry-point Layer provision owns each scoped service runtime.
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { emptyUsage } from "../../src/run/model.ts";
import type { SubagentServiceContract } from "../../src/run/service.ts";
import {
  controlForTask,
  eventually,
  fakeGate,
  fakeNativeReportBackendLayer,
  finished,
  inline,
  leaveInWorktree,
  mainChildren,
  profileLayerFor,
  reportTask,
  resultValue,
  runningTask,
  runWhere,
  stateOfTask,
  stoppedWallClock,
  testHost,
  withWorkflows,
  workflowFixture,
} from "./fixtures/workflow-harness.ts";

const bump = (counts: Map<string, number>, task: string) =>
  void counts.set(task, (counts.get(task) ?? 0) + 1);

/** Counts owned start attempts and refusals per task, as the workflow service makes them. */
const countingStarts = () => {
  const attempts = new Map<string, number>();
  const refusals = new Map<string, number>();
  const decorate = (service: SubagentServiceContract): SubagentServiceContract => ({
    ...service,
    startOwned: (request, owner) =>
      Effect.suspend(() => {
        bump(attempts, request.task);
        return service
          .startOwned(request, owner)
          .pipe(Effect.tapError(() => Effect.sync(() => bump(refusals, request.task))));
      }),
  });
  return { attempts, refusals, decorate };
};

/** The tasks whose agents have started, in the order they first ran. */
const startOrder = (fixture: ReturnType<typeof workflowFixture>, tasks: ReadonlyArray<string>) => {
  const order: string[] = [];
  for (const projection of fixture.projections)
    for (const run of projection.runs)
      if (tasks.includes(run.task) && run.state === "running" && !order.includes(run.task))
        order.push(run.task);
  return order;
};

describe("workflow agent admission", () => {
  it.live(
    "waits for root capacity without a start attempt, even through unrelated progress",
    () => {
      const { attempts, decorate } = countingStarts();
      // Four root slots: workflow agents may hold two of them while the main agent keeps two.
      const fixture = workflowFixture({
        profiles: profileLayerFor({ version: 6, nesting: { maxDirectChildren: 4, maxDepth: 3 } }),
        decorate,
      });
      return withWorkflows(fixture, (workflows, subagents) =>
        Effect.gen(function* () {
          yield* mainChildren(subagents, ["main-1", "main-2"]);
          const started = yield* workflows.start(
            {
              source: inline(
                'return await parallel([() => agent("first"), () => agent("second")]);',
              ),
              args: null,
            },
            testHost(),
          );
          // The first takes a free slot, since no workflow agent runs; the second would eat into
          // the main agent's reserve, so it waits for capacity.
          yield* runningTask(fixture, "first");
          const waiting = yield* runWhere(workflows, started.id, (run) =>
            run.agents.some((agent) => agent.waiting?.kind === "capacity"),
          );
          expect(waiting.agents.find((agent) => agent.state === "queued")?.waiting).toEqual({
            kind: "capacity",
          });
          const control = yield* controlForTask(fixture, "first");
          const published = fixture.projections.length;
          for (let index = 1; index <= 40; index++)
            control.offer({ type: "usage", usage: { ...emptyUsage(), output: index } });
          yield* eventually(
            () => (fixture.projections.length >= published + 40 ? true : undefined),
            "the progress revisions",
          );
          expect(attempts.get("second")).toBeUndefined();
          // The main agent still starts its own subagent in the slots workflows leave.
          yield* mainChildren(subagents, ["main-3"]);

          yield* reportTask(fixture, "first", "first done");
          yield* reportTask(fixture, "second", "second done");
          const run = yield* finished(workflows, started.id);
          expect(resultValue(run)).toEqual(["first done", "second done"]);
          expect(attempts.get("second")).toBe(1);
          expect(run.agents.every((agent) => agent.waiting === undefined)).toBe(true);
        }),
      );
    },
  );

  it.live("starts queued agents in queue order with one start attempt each", () => {
    const { attempts, refusals, decorate } = countingStarts();
    const tasks = ["t1", "t2", "t3", "t4", "t5", "t6"];
    // Five root slots and two held by the main agent: three run slots, but only one workflow
    // agent fits beside the main agent's reserve.
    const fixture = workflowFixture({
      profiles: profileLayerFor({ version: 6, nesting: { maxDirectChildren: 5, maxDepth: 3 } }),
      decorate,
    });
    return withWorkflows(fixture, (workflows, subagents) =>
      Effect.gen(function* () {
        yield* mainChildren(subagents, ["main-1", "main-2"]);
        const started = yield* workflows.start(
          {
            source: inline(
              `return await parallel([${tasks.map((task) => `"${task}"`).join(", ")}].map((task) => () => agent(task)));`,
            ),
            args: null,
          },
          testHost(),
        );
        const queued = yield* runWhere(
          workflows,
          started.id,
          (run) =>
            run.agents.length === tasks.length &&
            run.agents.filter((agent) => agent.waiting !== undefined).length === 5,
        );
        expect(queued.agents.map((agent) => agent.waiting?.kind)).toEqual([
          undefined,
          "capacity",
          "capacity",
          "slot",
          "slot",
          "slot",
        ]);
        for (const task of tasks) yield* reportTask(fixture, task, `${task} done`);
        const run = yield* finished(workflows, started.id);
        expect(resultValue(run)).toEqual(tasks.map((task) => `${task} done`));
        expect(startOrder(fixture, tasks)).toEqual(tasks);
        expect(tasks.map((task) => attempts.get(task))).toEqual(tasks.map(() => 1));
        expect(refusals.size).toBe(0);
      }),
    );
  });

  it.live("starts queued agents of several runs in one queue, alternating at equal times", () => {
    const { attempts, refusals, decorate } = countingStarts();
    const runs = [
      ["a1", "a2", "a3"],
      ["b1", "b2", "b3"],
    ];
    const tasks = runs.flat();
    const fixture = workflowFixture({
      profiles: profileLayerFor({ version: 6, nesting: { maxDirectChildren: 4, maxDepth: 3 } }),
      decorate,
    });
    return withWorkflows(fixture, (workflows, subagents) =>
      Effect.gen(function* () {
        // The main agent holds every root slot until both runs' calls are queued.
        yield* mainChildren(subagents, ["main-1", "main-2", "main-3", "main-4"]);
        const clock = yield* stoppedWallClock;
        const ids: string[] = [];
        for (const names of runs) {
          const started = yield* workflows
            .start(
              {
                source: inline(
                  `return await parallel([${names.map((task) => `"${task}"`).join(", ")}].map((task) => () => agent(task)));`,
                ),
                args: null,
              },
              testHost(),
            )
            .pipe(Effect.provideService(Clock.Clock, clock));
          ids.push(started.id);
        }
        // Each run holds two run slots, whose calls wait for root capacity; its third waits for one.
        for (const id of ids)
          yield* runWhere(
            workflows,
            id,
            (run) => run.agents.filter((agent) => agent.waiting !== undefined).length === 3,
          );
        // Two slots free up, but beside the main agent's reserve one workflow agent runs at a time.
        yield* reportTask(fixture, "main-3", "main-3 done");
        yield* reportTask(fixture, "main-4", "main-4 done");
        const order: string[] = [];
        for (const _task of tasks) {
          const next = yield* eventually(
            () =>
              tasks.find(
                (task) => !order.includes(task) && stateOfTask(fixture, task) === "running",
              ),
            "the next agent to run",
          );
          order.push(next);
          yield* reportTask(fixture, next, `${next} done`);
        }
        for (const id of ids) yield* finished(workflows, id);
        // Every call queued at the same time, so the runs take turns in call order.
        expect(order).toEqual(["a1", "b1", "a2", "b2", "a3", "b3"]);
        expect(tasks.map((task) => attempts.get(task))).toEqual(tasks.map(() => 1));
        expect(refusals.size).toBe(0);
      }),
    );
  });

  it.live("lets a workflow progress under a tiny direct-child limit", () => {
    const fixture = workflowFixture({
      profiles: profileLayerFor({ version: 6, nesting: { maxDirectChildren: 2, maxDepth: 3 } }),
    });
    return withWorkflows(fixture, (workflows, subagents) =>
      Effect.gen(function* () {
        yield* mainChildren(subagents, ["main"]);
        const started = yield* workflows.start(
          {
            source: inline(
              'return await parallel(["one", "two"].map((task) => () => agent(task)));',
            ),
            args: null,
          },
          testHost(),
        );
        // No slot is left beside the reserve, so agents run one at a time in the free slot.
        for (const task of ["one", "two"]) yield* reportTask(fixture, task, `${task} done`);
        const run = yield* finished(workflows, started.id);
        expect(resultValue(run)).toEqual(["one done", "two done"]);
      }),
    );
  });

  it.live(
    "counts a workflow writer still creating its worktree as a running workflow agent",
    () => {
      const fixture = workflowFixture({
        profiles: profileLayerFor({ version: 6, nesting: { maxDirectChildren: 4, maxDepth: 3 } }),
        worktrees: true,
      });
      return withWorkflows(fixture, (workflows, subagents) =>
        Effect.gen(function* () {
          const creating = yield* fakeGate;
          fixture.createGates.set("workspace-1", creating);
          yield* mainChildren(subagents, ["main-1", "main-2"]);
          const writing = yield* workflows.start(
            {
              source: inline(
                'return await agent("writer", { profile: "worker", isolation: "worktree" });',
                "writing",
              ),
              args: null,
            },
            testHost(),
          );
          yield* Deferred.await(creating.entered);
          const reading = yield* workflows.start(
            { source: inline('return await agent("reader");', "reading"), args: null },
            testHost(),
          );
          // The writer takes the free slot beside the main agent's reserve while it creates its
          // worktree, so the reader waits rather than eat into that reserve.
          yield* runWhere(workflows, reading.id, (run) =>
            run.agents.some((agent) => agent.waiting?.kind === "capacity"),
          );
          expect(stateOfTask(fixture, "reader")).toBeUndefined();
          // The main agent still starts its own subagent meanwhile.
          yield* mainChildren(subagents, ["main-3"]);

          yield* Deferred.succeed(creating.release, undefined);
          // Admitted into the worktree it created, never refused and sent to create another.
          expect(yield* leaveInWorktree(fixture, "writer", "changed")).toBe("workspace-1");
          expect(stateOfTask(fixture, "reader")).toBeUndefined();
          yield* reportTask(fixture, "writer", "written");
          yield* reportTask(fixture, "main-3", "main done");
          yield* reportTask(fixture, "reader", "read");
          expect((yield* finished(workflows, writing.id)).result?.text).toBe("written");
          expect((yield* finished(workflows, reading.id)).result?.text).toBe("read");
        }),
      );
    },
  );

  it.live("starts the next shared-checkout writer once the previous one has cleaned up", () => {
    const releaseGate = Deferred.makeUnsafe<void>();
    const { refusals, decorate } = countingStarts();
    const fixture = workflowFixture({
      backend: fakeNativeReportBackendLayer({ releaseGate }),
      decorate,
    });
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          {
            source: inline(`
              const results = [];
              for (const file of ["a.ts", "b.ts"])
                results.push(await agent("Migrate " + file, { profile: "worker" }));
              return results;`),
            args: null,
          },
          testHost(),
        );
        yield* reportTask(fixture, "Migrate a.ts", "a.ts migrated");
        // The first writer's process is still cleaning up, so the second one waits behind it
        // without a start attempt, and stays queued instead of resolving null.
        const queued = yield* runWhere(
          workflows,
          started.id,
          (run) => run.agents[1]?.waiting?.kind === "writer",
        );
        expect(queued.agents[1]).toMatchObject({
          state: "queued",
          waiting: { kind: "writer", paused: false },
        });
        expect(stateOfTask(fixture, "Migrate b.ts")).toBeUndefined();

        yield* Deferred.succeed(releaseGate, undefined);
        yield* reportTask(fixture, "Migrate b.ts", "b.ts migrated");
        const run = yield* finished(workflows, started.id);
        expect(resultValue(run)).toEqual(["a.ts migrated", "b.ts migrated"]);
        expect(run.agents.map((agent) => agent.state)).toEqual(["completed", "completed"]);
        expect(refusals.size).toBe(0);
      }),
    );
  });

  it.live("keeps starting readers while a writer waits behind another writer", () => {
    const fixture = workflowFixture({ concurrency: 2 });
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          {
            source: inline(`
              return await parallel([
                () => agent("Edit x.ts", { profile: "worker" }),
                () => agent("Edit y.ts", { profile: "worker" }),
                () => agent("Review the plan"),
              ]);`),
            args: null,
          },
          testHost(),
        );
        const [first, second] = yield* eventually(() => {
          const running = ["x.ts", "y.ts"].filter(
            (file) => stateOfTask(fixture, `Edit ${file}`) === "running",
          );
          return running.length === 1
            ? [running[0]!, running[0] === "x.ts" ? "y.ts" : "x.ts"]
            : undefined;
        }, "one running writer");
        // The queued writer holds no slot, so the reader takes it.
        const writerId = yield* runningTask(fixture, `Edit ${first}`);
        yield* runningTask(fixture, "Review the plan");
        expect(stateOfTask(fixture, `Edit ${second}`)).toBeUndefined();
        // The wait is logged with the writer it is queued behind.
        const queued = yield* runWhere(workflows, started.id, (run) =>
          run.logs.some((entry) => entry.message.includes(writerId)),
        );
        expect(queued.logs.find((entry) => entry.message.includes(writerId))?.level).toBe("info");

        yield* reportTask(fixture, "Review the plan", "plan reviewed");
        yield* reportTask(fixture, `Edit ${first}`, `${first} edited`);
        yield* reportTask(fixture, `Edit ${second}`, `${second} edited`);
        const run = yield* finished(workflows, started.id);
        expect(resultValue(run)).toEqual(["x.ts edited", "y.ts edited", "plan reviewed"]);
      }),
    );
  });

  it.live("runs parallel shared-checkout writers one at a time instead of dropping them", () => {
    const fixture = workflowFixture({ concurrency: 3 });
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          {
            source: inline(
              'return await parallel(["x.ts", "y.ts", "z.ts"].map((file) => () => agent("Edit " + file, { profile: "worker" })));',
            ),
            args: null,
          },
          testHost(),
        );
        for (let finishedWriters = 0; finishedWriters < 3; finishedWriters++) {
          const view = yield* runWhere(
            workflows,
            started.id,
            (run) => run.agents.filter((agent) => agent.state === "running").length === 1,
          );
          const running = view.agents.find((agent) => agent.state === "running")!;
          const task = ["x.ts", "y.ts", "z.ts"].find(
            (file) => stateOfTask(fixture, `Edit ${file}`) === "running",
          )!;
          expect(running).toBeDefined();
          yield* reportTask(fixture, `Edit ${task}`, `${task} edited`);
          yield* runWhere(
            workflows,
            started.id,
            (run) =>
              run.agents.filter((agent) => agent.state === "completed").length > finishedWriters,
          );
        }
        const run = yield* finished(workflows, started.id);
        expect(resultValue(run)).toEqual(["x.ts edited", "y.ts edited", "z.ts edited"]);
      }),
    );
  });
});
