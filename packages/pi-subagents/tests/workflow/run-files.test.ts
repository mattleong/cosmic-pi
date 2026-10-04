// Explicit test entry-point Layer provision owns each scoped service runtime.
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { workflowStartText, workflowStatusText } from "../../src/tools/workflow-format.ts";
import type { WorkflowRunView } from "../../src/workflow/model.ts";
import {
  eventually,
  finished,
  hurriedClock,
  inline,
  journalLines,
  memoryRunFiles,
  reportTask,
  runningTask,
  runWhere,
  script,
  stoppedWallClock,
  testHost,
  withWorkflows,
  workflowFixture,
  workflowSessionKey,
} from "./fixtures/workflow-harness.ts";

/** Where the memory store keeps a run's results journal, set before the view names it. */
const journalOf = (run: WorkflowRunView) =>
  `/agent/subagents/workflow-runs/${run.id}/journal.jsonl`;

const labelsAndStates = (lines: ReturnType<typeof journalLines>) =>
  lines.map((line) => [line["label"], line["state"]]);

describe("a run's saved script", () => {
  it.live("is saved for editing, and the start result names it", () => {
    const fixture = workflowFixture();
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const request = inline("return 1;");
        const started = yield* workflows.start({ source: request, args: null }, testHost());
        expect(fixture.runFiles.scripts.get(started.id)).toBe(request.script);
        expect(started.scriptPath).toBeDefined();
        expect(workflowStartText(started)).toContain(started.scriptPath);
        yield* finished(workflows, started.id);
      }),
    );
  });

  it.live("gets its own directory when Pi processes start runs in the same millisecond", () =>
    Effect.gen(function* () {
      const runFiles = memoryRunFiles();
      // Each fixture is a Pi process sharing the agent directory, with the same wall clock.
      const startOne = () =>
        withWorkflows(workflowFixture({ runFiles }), (workflows) =>
          workflows
            .start({ source: inline("return 1;"), args: null }, testHost())
            .pipe(Effect.map((run) => run.id)),
        );
      const ids = yield* Effect.all([startOne(), startOne()]).pipe(
        Effect.provideService(Clock.Clock, yield* stoppedWallClock),
      );
      expect(new Set(ids).size).toBe(2);
    }),
  );

  it.live("is marked recent periodically while its run is live, and not after", () => {
    const fixture = workflowFixture();
    return Effect.gen(function* () {
      const clock = yield* hurriedClock("20 millis");
      return yield* withWorkflows(fixture, (workflows) =>
        Effect.gen(function* () {
          const started = yield* workflows.start(
            { source: inline('return await agent("hold");'), args: null },
            testHost(),
          );
          yield* runningTask(fixture, "hold");
          const directory = `/agent/subagents/workflow-runs/${started.id}`;
          const touches = () =>
            fixture.runFiles.touches.filter((touched) => touched === directory).length;
          yield* eventually(() => (touches() >= 2 ? true : undefined), "two directory refreshes");
          yield* workflows.stop(started.id);
          const afterStop = touches();
          yield* Effect.sleep("100 millis");
          expect(touches()).toBe(afterStop);
        }),
      ).pipe(Effect.provideService(Clock.Clock, clock));
    });
  });

  it.live("is never pruned while its run is live", () => {
    const fixture = workflowFixture();
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const first = yield* workflows.start(
          { source: inline('return await agent("hold");'), args: null },
          testHost(),
        );
        yield* runningTask(fixture, "hold");
        const second = yield* workflows.start(
          { source: inline("return 2;"), args: null },
          testHost(),
        );
        expect([...(fixture.runFiles.live.at(-1) ?? [])]).toEqual([first.id]);
        yield* finished(workflows, second.id);
        yield* reportTask(fixture, "hold", "held");
        yield* finished(workflows, first.id);
      }),
    );
  });

  it.live("points a saved workflow's fix at its own file, not the run's copy", () => {
    const fixture = workflowFixture({
      scripts: { review: script('throw new Error("broken");', "review") },
    });
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          { source: { kind: "saved", name: "review" }, args: null },
          testHost(),
        );
        const original = "/agent/workflows/review.js";
        const copy = started.scriptPath;
        expect(copy).toBeDefined();
        expect(workflowStartText(started)).toContain(original);
        expect(workflowStartText(started)).toContain('name: "review"');
        expect(workflowStartText(started)).not.toContain(copy);
        const done = yield* finished(workflows, started.id);
        expect(done.state).toBe("failed");
        const notification = yield* eventually(() => fixture.delivered[0], "the notification");
        for (const text of [notification.content, workflowStatusText(done, done.endedAt ?? 0)]) {
          expect(text).toContain(original);
          expect(text).toContain(`resumeFromRunId: "${started.id}"`);
          expect(text).not.toContain(copy);
        }
      }),
    );
  });

  it.live("restarts an interrupted saved workflow by name, not from the run's copy", () => {
    const sessionKey = workflowSessionKey();
    const scripts = { review: script('return await agent("hold");', "review") };
    const first = workflowFixture({ sessionKey, scripts });
    return Effect.gen(function* () {
      const started = yield* withWorkflows(first, (workflows) =>
        Effect.gen(function* () {
          const run = yield* workflows.start(
            { source: { kind: "saved", name: "review" }, args: null },
            testHost(),
          );
          yield* runningTask(first, "hold");
          return run;
        }),
      );
      const second = workflowFixture({ sessionKey, scripts });
      yield* withWorkflows(second, () =>
        Effect.gen(function* () {
          const notice = yield* eventually(() => second.delivered[0], "the interrupted notice");
          expect(notice.content).toContain('name: "review"');
          expect(notice.content).toContain(`resumeFromRunId: "${started.id}"`);
          expect(notice.content).not.toContain(started.scriptPath);
        }),
      );
    });
  });

  it.live("doesn't stop the run from starting when it can't be saved", () => {
    const runFiles = memoryRunFiles();
    runFiles.failCreate = true;
    const fixture = workflowFixture({ runFiles });
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          { source: inline("return 1;"), args: null },
          testHost(),
        );
        expect(started.scriptPath).toBeUndefined();
        expect(started.warnings).toHaveLength(1);
        const done = yield* finished(workflows, started.id);
        expect(done.state).toBe("completed");
      }),
    );
  });
});

describe("a run's results journal", () => {
  it.live("records every finished call with its state and actual result", () => {
    const fixture = workflowFixture();
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          {
            source: inline(`
              phase("Find");
              const found = await agent("find bugs", { label: "finder" });
              const skipped = await agent("skip me", { label: "skippable" });
              return { found, skipped };`),
            args: null,
          },
          testHost(),
        );
        const finderId = yield* reportTask(fixture, "find bugs", "Two bugs.");
        const waiting = yield* runWhere(workflows, started.id, (run) =>
          run.agents.some((agent) => agent.label === "skippable"),
        );
        const skippable = waiting.agents.find((agent) => agent.label === "skippable")!;
        yield* runningTask(fixture, "skip me");
        yield* workflows.skip(skippable.runId);
        const done = yield* finished(workflows, started.id);
        expect(done.journalPath).toBeDefined();
        expect(journalLines(fixture.runFiles, done.journalPath)).toEqual([
          expect.objectContaining({
            callId: 1,
            label: "finder",
            phase: "Find",
            state: "completed",
            runId: finderId,
            result: "Two bugs.",
          }),
          expect.objectContaining({
            callId: 2,
            label: "skippable",
            state: "skipped",
            runId: skippable.runId,
            result: null,
            reason: expect.any(String),
          }),
        ]);
        const notification = yield* eventually(() => fixture.delivered[0], "the notification");
        expect(notification.content).toContain(done.journalPath);
        expect(workflowStatusText(done, done.endedAt ?? 0)).toContain(done.journalPath);
      }),
    );
  });

  it.live("records reused results with the agent that produced them", () => {
    const fixture = workflowFixture();
    const find = 'phase("Find"); const found = await agent("find it", { label: "finder" });';
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const original = yield* workflows.start(
          { source: inline(`${find}\nthrow new Error("not yet");`), args: null },
          testHost(),
        );
        const finderId = yield* reportTask(fixture, "find it", "Found.");
        yield* finished(workflows, original.id);
        const resumed = yield* workflows.start(
          {
            source: inline(`${find}\nreturn found;`),
            args: null,
            resumeFromRunId: original.id,
          },
          testHost(),
        );
        const done = yield* finished(workflows, resumed.id);
        expect(journalLines(fixture.runFiles, done.journalPath)).toEqual([
          expect.objectContaining({
            label: "finder",
            state: "completed",
            reused: true,
            runId: finderId,
            result: "Found.",
          }),
        ]);
      }),
    );
  });

  it.live("records a finished call's line even when the run stops while it waits to write", () => {
    const runFiles = memoryRunFiles();
    const release = Deferred.makeUnsafe<void>();
    runFiles.holdNextAppend = Deferred.await(release);
    const fixture = workflowFixture({ runFiles });
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          {
            source: inline(
              'return await Promise.all([agent("first", { label: "first" }), agent("second", { label: "second" })]);',
            ),
            args: null,
          },
          testHost(),
        );
        const journal = journalOf(started);
        // The first line is written, and its append keeps the journal busy.
        yield* reportTask(fixture, "first", "1");
        yield* eventually(() => journalLines(runFiles, journal)[0], "the first line");
        yield* reportTask(fixture, "second", "2");
        yield* runWhere(workflows, started.id, (run) =>
          run.agents.some((agent) => agent.label === "second" && agent.state === "completed"),
        );
        const stopping = yield* workflows.stop(started.id).pipe(Effect.forkScoped);
        yield* runWhere(workflows, started.id, (run) => run.state === "stopping");
        yield* Deferred.succeed(release, undefined);
        expect((yield* Fiber.join(stopping)).state).toBe("stopped");
        expect(labelsAndStates(journalLines(runFiles, journal))).toEqual([
          ["first", "completed"],
          ["second", "completed"],
        ]);
      }),
    );
  });

  it.live("records a reused call's line even when the run stops while it waits to write", () => {
    const runFiles = memoryRunFiles();
    const fixture = workflowFixture({ runFiles });
    const calls =
      'const both = await Promise.all([agent("one", { label: "one" }), agent("two", { label: "two" })]);';
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const original = yield* workflows.start(
          { source: inline(`${calls}\nthrow new Error("not yet");`), args: null },
          testHost(),
        );
        yield* reportTask(fixture, "one", "1");
        yield* reportTask(fixture, "two", "2");
        yield* finished(workflows, original.id);
        const release = Deferred.makeUnsafe<void>();
        runFiles.holdNextAppend = Deferred.await(release);
        const resumed = yield* workflows.start(
          {
            source: inline(`${calls}\nreturn both;`),
            args: null,
            resumeFromRunId: original.id,
          },
          testHost(),
        );
        // One reused line is written and keeps the journal busy; the other call waits to write.
        yield* runWhere(workflows, resumed.id, (run) => run.reused === 2);
        const stopping = yield* workflows.stop(resumed.id).pipe(Effect.forkScoped);
        yield* runWhere(workflows, resumed.id, (run) => run.state === "stopping");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(stopping);
        const lines = journalLines(runFiles, journalOf(resumed));
        expect(lines.map((line) => line["label"]).sort()).toEqual(["one", "two"]);
        expect(lines.every((line) => line["reused"] === true)).toBe(true);
      }),
    );
  });

  it.live("warns once and lets the run finish when the journal can't be written", () => {
    const runFiles = memoryRunFiles();
    runFiles.failAppend = true;
    const fixture = workflowFixture({ runFiles });
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          {
            source: inline('return [await agent("one"), await agent("two")];'),
            args: null,
          },
          testHost(),
        );
        yield* reportTask(fixture, "one", "1");
        yield* reportTask(fixture, "two", "2");
        const done = yield* finished(workflows, started.id);
        expect(done.state).toBe("completed");
        expect(done.journalPath).toBeUndefined();
        expect(done.warningCount).toBe(1);
      }),
    );
  });
});
