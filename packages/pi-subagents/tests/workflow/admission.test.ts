// Explicit test entry-point Layer provision owns each scoped service runtime.
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { emptyUsage } from "../../src/run/model.ts";
import type { SubagentServiceContract } from "../../src/run/service.ts";
import {
  controlForTask,
  eventually,
  fakeNativeReportBackendLayer,
  finished,
  profileLayerFor,
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

const inline = (body: string) => ({ kind: "inline" as const, script: script(body) });

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

describe("workflow agent admission", () => {
  it.live("doesn't retry a capacity-limited start for unrelated progress", () => {
    const { attempts, decorate } = countingStarts();
    const fixture = workflowFixture({
      concurrency: 2,
      profiles: profileLayerFor({ version: 6, nesting: { maxDirectChildren: 1, maxDepth: 3 } }),
      decorate,
    });
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          {
            source: inline('return await parallel([() => agent("first"), () => agent("second")]);'),
            args: null,
          },
          testHost(),
        );
        yield* runningTask(fixture, "first");
        yield* eventually(
          () => ((attempts.get("second") ?? 0) >= 1 ? true : undefined),
          "the refused second start",
        );
        const control = yield* controlForTask(fixture, "first");
        const published = fixture.projections.length;
        for (let index = 1; index <= 40; index++)
          control.offer({ type: "usage", usage: { ...emptyUsage(), output: index } });
        yield* eventually(
          () => (fixture.projections.length >= published + 40 ? true : undefined),
          "the progress revisions",
        );
        expect(attempts.get("second")).toBe(1);
        expect(stateOfTask(fixture, "second")).toBeUndefined();

        yield* reportTask(fixture, "first", "first done");
        yield* reportTask(fixture, "second", "second done");
        const run = yield* finished(workflows, started.id);
        expect(resultValue(run)).toEqual(["first done", "second done"]);
        expect(attempts.get("second")).toBeLessThanOrEqual(3);
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
        // The first writer's process is still cleaning up, so the second one is refused once
        // and stays queued instead of resolving null.
        yield* eventually(
          () => ((refusals.get("Migrate b.ts") ?? 0) >= 1 ? true : undefined),
          "the refused second writer",
        );
        const queued = yield* runWhere(workflows, started.id, (run) => run.agents.length === 2);
        expect(queued.agents[1]?.state).toBe("queued");
        expect(stateOfTask(fixture, "Migrate b.ts")).toBeUndefined();

        yield* Deferred.succeed(releaseGate, undefined);
        yield* reportTask(fixture, "Migrate b.ts", "b.ts migrated");
        const run = yield* finished(workflows, started.id);
        expect(resultValue(run)).toEqual(["a.ts migrated", "b.ts migrated"]);
        expect(run.agents.map((agent) => agent.state)).toEqual(["completed", "completed"]);
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
