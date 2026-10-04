// Explicit test entry-point Layer provision owns each scoped service runtime.
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { subagentErrorCode } from "../../src/run/errors.ts";
import type { SubagentServiceContract } from "../../src/run/service.ts";
import {
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

/** A script that runs one agent per task in parallel and returns their results. */
const fanOut = (tasks: ReadonlyArray<string>) =>
  inline(
    `return await parallel([${tasks.map((task) => `"${task}"`).join(", ")}].map((task) => () => agent(task)));`,
  );

describe("workflow agent admission", () => {
  it.live("leaves the main agent every subagent slot while a run fills its width", () => {
    const { refusals, decorate } = countingStarts();
    const tasks = ["w1", "w2", "w3", "w4"];
    const nestingPolicy = { maxDirectChildren: 4, maxDepth: 3 };
    const fixture = workflowFixture({
      concurrency: tasks.length,
      profiles: profileLayerFor({ version: 6, nesting: nestingPolicy }),
      decorate,
    });
    return withWorkflows(fixture, (workflows, subagents) =>
      Effect.gen(function* () {
        const started = yield* workflows.start({ source: fanOut(tasks), args: null }, testHost());
        for (const task of tasks) yield* runningTask(fixture, task);
        // Workflow agents take none of the root's direct-child slots, so the main agent can
        // still start as many children as its limit allows, and no more.
        yield* mainChildren(subagents, ["main-1", "main-2", "main-3", "main-4"], nestingPolicy);
        const full = yield* mainChildren(subagents, ["main-5"], nestingPolicy).pipe(Effect.flip);
        expect(subagentErrorCode(full)).toBe("direct_child_capacity");

        for (const task of tasks) yield* reportTask(fixture, task, `${task} done`);
        const run = yield* finished(workflows, started.id);
        expect(resultValue(run)).toEqual(tasks.map((task) => `${task} done`));
        expect(refusals.size).toBe(0);
      }),
    );
  });

  it.live("runs a run's full width whatever the main agent's subagent limit", () => {
    const tasks = ["t1", "t2", "t3", "t4"];
    const nestingPolicy = { maxDirectChildren: 2, maxDepth: 3 };
    const fixture = workflowFixture({
      concurrency: 3,
      profiles: profileLayerFor({ version: 6, nesting: nestingPolicy }),
    });
    return withWorkflows(fixture, (workflows, subagents) =>
      Effect.gen(function* () {
        // The main agent's own children fill every direct-child slot.
        yield* mainChildren(subagents, ["main-1", "main-2"], nestingPolicy);
        const started = yield* workflows.start({ source: fanOut(tasks), args: null }, testHost());
        const queued = yield* runWhere(
          workflows,
          started.id,
          (run) =>
            run.agents.filter((agent) => agent.state === "running").length === 3 &&
            run.agents.some((agent) => agent.waiting?.kind === "slot"),
        );
        expect(queued.agents.map((agent) => agent.waiting?.kind)).toEqual([
          undefined,
          undefined,
          undefined,
          "slot",
        ]);
        for (const task of tasks) yield* reportTask(fixture, task, `${task} done`);
        const run = yield* finished(workflows, started.id);
        expect(resultValue(run)).toEqual(tasks.map((task) => `${task} done`));
      }),
    );
  });

  it.live("starts a run's queued agents in call order with one start attempt each", () => {
    const { attempts, refusals, decorate } = countingStarts();
    const tasks = ["t1", "t2", "t3", "t4", "t5"];
    const fixture = workflowFixture({ concurrency: 1, decorate });
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const started = yield* workflows.start({ source: fanOut(tasks), args: null }, testHost());
        const queued = yield* runWhere(
          workflows,
          started.id,
          (run) =>
            run.agents.length === tasks.length &&
            run.agents.filter((agent) => agent.waiting !== undefined).length === 4,
        );
        expect(queued.agents.map((agent) => agent.waiting?.kind)).toEqual([
          undefined,
          "slot",
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

  it.live("gives each run its own width", () => {
    const runs = [
      ["a1", "a2", "a3"],
      ["b1", "b2", "b3"],
    ];
    const nestingPolicy = { maxDirectChildren: 2, maxDepth: 3 };
    const fixture = workflowFixture({
      concurrency: 2,
      profiles: profileLayerFor({ version: 6, nesting: nestingPolicy }),
    });
    return withWorkflows(fixture, (workflows, subagents) =>
      Effect.gen(function* () {
        yield* mainChildren(subagents, ["main-1", "main-2"], nestingPolicy);
        const ids: string[] = [];
        for (const tasks of runs)
          ids.push((yield* workflows.start({ source: fanOut(tasks), args: null }, testHost())).id);
        // Each run runs two agents at once, beside the other run's two and the main agent's
        // children, and its third waits for one of its own slots.
        for (const id of ids) {
          const view = yield* runWhere(
            workflows,
            id,
            (run) =>
              run.agents.filter((agent) => agent.state === "running").length === 2 &&
              run.agents.some((agent) => agent.waiting?.kind === "slot"),
          );
          expect(view.agents.map((agent) => agent.waiting?.kind)).toEqual([
            undefined,
            undefined,
            "slot",
          ]);
        }
        for (const task of runs.flat()) yield* reportTask(fixture, task, `${task} done`);
        for (const [index, id] of ids.entries())
          expect(resultValue(yield* finished(workflows, id))).toEqual(
            runs[index]!.map((task) => `${task} done`),
          );
      }),
    );
  });

  it.live("holds no direct-child slot for a workflow writer creating its worktree", () => {
    const nestingPolicy = { maxDirectChildren: 2, maxDepth: 3 };
    const fixture = workflowFixture({
      profiles: profileLayerFor({ version: 6, nesting: nestingPolicy }),
      worktrees: true,
    });
    return withWorkflows(fixture, (workflows, subagents) =>
      Effect.gen(function* () {
        const creating = yield* fakeGate;
        fixture.createGates.set("workspace-1", creating);
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
        // Meanwhile the main agent fills its slots, and another run's reader starts.
        yield* mainChildren(subagents, ["main-1", "main-2"], nestingPolicy);
        const reading = yield* workflows.start(
          { source: inline('return await agent("reader");', "reading"), args: null },
          testHost(),
        );
        yield* runningTask(fixture, "reader");

        yield* Deferred.succeed(creating.release, undefined);
        // Admitted into the worktree it created, never refused and sent to create another.
        expect(yield* leaveInWorktree(fixture, "writer", "changed")).toBe("workspace-1");
        yield* reportTask(fixture, "writer", "written");
        yield* reportTask(fixture, "reader", "read");
        expect((yield* finished(workflows, writing.id)).result?.text).toBe("written");
        expect((yield* finished(workflows, reading.id)).result?.text).toBe("read");
      }),
    );
  });

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
