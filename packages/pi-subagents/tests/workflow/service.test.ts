// Explicit test entry-point Layer provision owns each scoped service runtime.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { WorkflowService } from "../../src/workflow/service.ts";
import type { StartSubagentRequest } from "../../src/run/model.ts";
import {
  controlForTask,
  eventually,
  fakeNativeReportBackendLayer,
  finished,
  inline,
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

describe("workflow runs", () => {
  it.live("returns the script value once its agents report and notifies the root once", () => {
    const fixture = workflowFixture();
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          {
            source: inline(
              'phase("Find"); const found = await agent("find bugs", { label: "finder" }); return { found, args };',
            ),
            args: { scope: "src" },
          },
          testHost(),
        );
        expect(started.state).toBe("running");
        yield* reportTask(fixture, "find bugs", "Two bugs in src/a.ts.");
        const run = yield* finished(workflows, started.id);
        expect(run.state).toBe("completed");
        expect(resultValue(run)).toEqual({
          found: "Two bugs in src/a.ts.",
          args: { scope: "src" },
        });
        expect(run.phases.map((phase) => phase.title)).toEqual(["Main", "Find"]);
        expect(run.agents).toEqual([
          expect.objectContaining({ label: "finder", phase: "Find", state: "completed" }),
        ]);
        yield* eventually(() => fixture.delivered[0], "the workflow notification");
        expect(fixture.workflowNotifications).toEqual([
          expect.objectContaining({ runId: started.id, outcome: "completed" }),
        ]);
        expect(fixture.workflowNotifications[0]!.content).toContain("Two bugs in src/a.ts.");
        // The workflow owns its agents' reports; none reach the root on their own.
        expect(fixture.rootNotifications.filter((n) => n.type === "completed")).toEqual([]);
      }),
    );
  });

  it.live("queues agents beyond the run's concurrency and drains them as slots free", () => {
    const fixture = workflowFixture({ concurrency: 1 });
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          {
            source: inline(
              'return await parallel(["one", "two", "three"].map((task) => () => agent(task)));',
            ),
            args: null,
          },
          testHost(),
        );
        const queued = yield* runWhere(
          workflows,
          started.id,
          (run) => run.agents.length === 3 && run.agents.some((agent) => agent.state === "running"),
        );
        expect(queued.agents.map((agent) => agent.state).sort()).toEqual([
          "queued",
          "queued",
          "running",
        ]);
        for (const task of ["one", "two", "three"]) {
          const running = yield* runWhere(workflows, started.id, (run) =>
            run.agents.some((agent) => agent.state === "running"),
          );
          expect(running.agents.filter((agent) => agent.state === "running")).toHaveLength(1);
          yield* reportTask(fixture, task, `${task} done`);
        }
        const run = yield* finished(workflows, started.id);
        expect(resultValue(run)).toEqual(["one done", "two done", "three done"]);
      }),
    );
  });

  it.live("waits for root capacity instead of failing an agent", () => {
    const fixture = workflowFixture({
      concurrency: 2,
      profiles: profileLayerFor({ version: 6, nesting: { maxDirectChildren: 1, maxDepth: 3 } }),
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
        const waiting = yield* runWhere(workflows, started.id, (run) => run.agents.length === 2);
        expect(waiting.agents.find((agent) => agent.label === "agent-2")?.state).toBe("queued");
        expect(stateOfTask(fixture, "second")).toBeUndefined();
        yield* reportTask(fixture, "first", "first done");
        yield* reportTask(fixture, "second", "second done");
        const run = yield* finished(workflows, started.id);
        expect(resultValue(run)).toEqual(["first done", "second done"]);
      }),
    );
  });

  it.live("resolves failed, stopped and skipped agents to null and keeps the script going", () => {
    const fixture = workflowFixture({ concurrency: 2 });
    return withWorkflows(fixture, (workflows, subagents) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          {
            source: inline(
              'const results = await parallel(["fails", "stopped", "skipped"].map((task) => () => agent(task, { label: task }))); return { results, after: "continued" };',
            ),
            args: null,
          },
          testHost(),
        );
        const failing = yield* runningTask(fixture, "fails");
        const control = yield* controlForTask(fixture, "fails");
        control.offer({ type: "protocol_error", message: "Malformed frame." });
        yield* subagents.stop(yield* runningTask(fixture, "stopped"));
        const queued = yield* runWhere(workflows, started.id, (run) =>
          run.agents.some((agent) => agent.label === "skipped" && agent.state === "queued"),
        );
        yield* workflows.skip(queued.agents.find((agent) => agent.label === "skipped")!.runId);
        const run = yield* finished(workflows, started.id);
        expect(resultValue(run)).toEqual({
          results: [null, null, null],
          after: "continued",
        });
        expect(Object.fromEntries(run.agents.map((agent) => [agent.label, agent.state]))).toEqual({
          fails: "failed",
          stopped: "stopped",
          skipped: "skipped",
        });
        expect(run.logs.filter((entry) => entry.level === "warning")).toHaveLength(3);
        expect(failing).toBeDefined();
      }),
    );
  });

  it.live("rejects invalid agent() calls without starting an agent", () => {
    const fixture = workflowFixture();
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          {
            source: inline(`
              const errors = [];
              for (const options of [{ model: "opus" }, { profile: "unknown" }, { schema: { $ref: "#/x" } }, { colour: "red" }]) {
                try { await agent("task", options); } catch (error) { errors.push(error.message); }
              }
              return errors;`),
            args: null,
          },
          testHost(),
        );
        const run = yield* finished(workflows, started.id);
        expect(resultValue(run)).toEqual([
          expect.stringContaining("profile"),
          expect.stringContaining("unknown"),
          expect.any(String),
          expect.stringContaining("colour"),
        ]);
        expect(run.agents).toEqual([]);
        expect(fixture.backend.controls).toEqual([]);
      }),
    );
  });

  it.live("stops agents the script left running when it returns", () => {
    const fixture = workflowFixture();
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          {
            source: inline('agent("forgotten"); await agent("awaited"); return "early";'),
            args: null,
          },
          testHost(),
        );
        yield* runningTask(fixture, "forgotten");
        yield* reportTask(fixture, "awaited", "done");
        const run = yield* finished(workflows, started.id);
        expect(run.state).toBe("completed");
        expect(run.result?.text).toBe("early");
        expect(stateOfTask(fixture, "forgotten")).toBe("stopped");
        expect(run.agents.find((agent) => agent.label === "agent-1")?.state).toBe("stopped");
      }),
    );
  });

  it.live("stop interrupts the script and stops its agents before reporting stopped", () => {
    const fixture = workflowFixture();
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          {
            source: inline('return await parallel([() => agent("left"), () => agent("right")]);'),
            args: null,
          },
          testHost(),
        );
        yield* runningTask(fixture, "left");
        yield* runningTask(fixture, "right");
        const stopped = yield* workflows.stop(started.id);
        expect(stopped.state).toBe("stopped");
        expect(stateOfTask(fixture, "left")).toBe("stopped");
        expect(stateOfTask(fixture, "right")).toBe("stopped");
        expect(stopped.agents.map((agent) => agent.state)).toEqual(["stopped", "stopped"]);
        // Stopping again is a no-op that returns the same final state.
        expect((yield* workflows.stop(started.id)).state).toBe("stopped");
        yield* eventually(() => fixture.delivered[0], "the stopped notification");
        expect(fixture.workflowNotifications.map((n) => n.outcome)).toEqual(["stopped"]);
      }),
    );
  });

  it.live("interrupts runs on session teardown without notifying", () => {
    const fixture = workflowFixture();
    return Effect.gen(function* () {
      yield* withWorkflows(fixture, (workflows) =>
        Effect.gen(function* () {
          yield* workflows.start(
            { source: inline('return await agent("long");'), args: null },
            testHost(),
          );
          yield* runningTask(fixture, "long");
        }),
      );
      expect(stateOfTask(fixture, "long")).toBe("stopped");
      expect(fixture.workflowNotifications).toEqual([]);
    });
  });

  it.live("reports a failed script with its error and how to resume", () => {
    const fixture = workflowFixture();
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          { source: inline('log("starting"); throw new TypeError("bad input");'), args: null },
          testHost(),
        );
        const run = yield* finished(workflows, started.id);
        expect(run.state).toBe("failed");
        expect(run.failure).toMatchObject({ name: "TypeError", message: "bad input" });
        yield* eventually(() => fixture.delivered[0], "the failure notification");
        const content = fixture.workflowNotifications[0]!.content;
        expect(content).toContain("bad input");
        expect(content).toContain(started.id);
      }),
    );
  });

  it.live("clips a large result and saves the full value for the main agent", () => {
    const fixture = workflowFixture();
    return Effect.gen(function* () {
      const workflows = yield* WorkflowService;
      const fs = yield* FileSystem.FileSystem;
      const started = yield* workflows.start(
        { source: inline('return "head" + "x".repeat(40000) + "tail";'), args: null },
        testHost(),
      );
      const run = yield* finished(workflows, started.id);
      expect(run.result?.clipped).toBe(true);
      expect(run.result!.text.length).toBeLessThan(40_000);
      const path = run.result?.path;
      expect(path).toBeDefined();
      const saved = yield* fs.readFileString(path!);
      yield* fs.remove(path!);
      expect(saved).toHaveLength(40_008);
      expect(saved.endsWith("tail")).toBe(true);
      yield* eventually(() => fixture.delivered[0], "the notification");
      expect(fixture.workflowNotifications[0]!.content).toContain(path!);
    }).pipe(Effect.scoped, Effect.provide(fixture.layer));
  });

  it.live("retries a notification the host could not accept", () => {
    let attempts = 0;
    const fixture = workflowFixture({ accept: () => ++attempts > 1 });
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          { source: inline("return 1;"), args: null },
          testHost(),
        );
        yield* finished(workflows, started.id);
        yield* eventually(() => fixture.delivered[0], "the retried notification");
        expect(fixture.workflowNotifications).toHaveLength(2);
        expect(fixture.delivered).toHaveLength(1);
      }),
    );
  });

  it.live("rejects syntax errors, oversized args and unknown resumes before running", () => {
    const fixture = workflowFixture();
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const syntax = yield* workflows
          .start({ source: inline("return (;"), args: null }, testHost())
          .pipe(Effect.flip);
        expect(syntax._tag).toBe("WorkflowScriptError");
        const large = yield* workflows
          .start({ source: inline("return 1;"), args: "x".repeat(70_000) }, testHost())
          .pipe(Effect.flip);
        expect(large._tag).toBe("WorkflowRequestError");
        const unknown = yield* workflows
          .start({ source: inline("return 1;"), args: null, resumeFromRunId: "wf-x-1" }, testHost())
          .pipe(Effect.flip);
        expect(unknown._tag).toBe("WorkflowRequestError");
        expect(yield* workflows.list).toEqual([]);
      }),
    );
  });
});

describe("workflow resume", () => {
  it.live("reuses identical earlier calls in order and runs changed calls live", () => {
    const fixture = workflowFixture({ concurrency: 1 });
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const first = yield* workflows.start(
          {
            source: inline(
              'return [await agent("same"), await agent("same", { label: "again" }), await agent("other")];',
            ),
            args: null,
          },
          testHost(),
        );
        yield* reportTask(fixture, "same", "first same");
        // The identical second call is a separate agent with the same task.
        yield* eventually(
          () => (fixture.backend.controls.length === 2 ? true : undefined),
          "the second identical call",
        );
        yield* reportTask(fixture, "same", "second same");
        yield* reportTask(fixture, "other", "other result");
        expect(resultValue(yield* finished(workflows, first.id))).toEqual([
          "first same",
          "second same",
          "other result",
        ]);

        const resumed = yield* workflows.start(
          {
            source: inline(
              'return [await agent("same"), await agent("same"), await agent("changed")];',
            ),
            args: null,
            resumeFromRunId: first.id,
          },
          testHost(),
        );
        yield* reportTask(fixture, "changed", "changed result");
        const run = yield* finished(workflows, resumed.id);
        expect(resultValue(run)).toEqual(["first same", "second same", "changed result"]);
        expect(run.reused).toBe(2);
        expect(run.resumedFrom).toBe(first.id);
        expect(run.agents.map((agent) => agent.label)).toEqual(["agent-1"]);
        expect(fixture.backend.controls).toHaveLength(4);
      }),
    );
  });

  it.live("runs the check again when only the shared-checkout writer before it changed", () => {
    const fixture = workflowFixture();
    const implementThenCheck = (task: string) =>
      inline(
        `const fixed = await agent(${JSON.stringify(task)}, { profile: "worker" }); return [fixed, await agent("run the tests")];`,
      );
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const first = yield* workflows.start(
          { source: implementThenCheck("implement the fix"), args: null },
          testHost(),
        );
        yield* reportTask(fixture, "implement the fix", "Implemented.");
        yield* reportTask(fixture, "run the tests", "Tests fail.");
        expect((yield* finished(workflows, first.id)).state).toBe("completed");

        const resumed = yield* workflows.start(
          {
            source: implementThenCheck("implement the fix properly"),
            args: null,
            resumeFromRunId: first.id,
          },
          testHost(),
        );
        yield* reportTask(fixture, "implement the fix properly", "Implemented properly.");
        yield* reportTask(fixture, "run the tests", "Tests pass.");
        const run = yield* finished(workflows, resumed.id);
        expect(resultValue(run)).toEqual(["Implemented properly.", "Tests pass."]);
        expect(run.reused).toBe(0);
      }),
    );
  });

  it.live(
    "fails a run on an invalid call inside parallel() and reuses its agents on resume",
    () => {
      const fixture = workflowFixture();
      const source = (options: string) =>
        inline(
          `const map = await agent("map the code"); return [map, ...(await parallel([() => agent("review the map", ${options})]))];`,
        );
      return withWorkflows(fixture, (workflows) =>
        Effect.gen(function* () {
          const failed = yield* workflows.start(
            { source: source('{ agentType: "Explore" }'), args: null },
            testHost(),
          );
          yield* reportTask(fixture, "map the code", "Mapped.");
          const run = yield* finished(workflows, failed.id);
          expect(run.state).toBe("failed");
          expect(run.failure?.message).toContain('profile: "scout"');
          expect(stateOfTask(fixture, "review the map")).toBeUndefined();
          const notification = yield* eventually(() => fixture.delivered[0], "the notification");
          expect(notification.outcome).toBe("failed");
          expect(notification.content).toContain(run.scriptPath ?? "the script copy");
          expect(notification.content).toContain(`resumeFromRunId: "${failed.id}"`);

          const resumed = yield* workflows.start(
            { source: source('{ profile: "scout" }'), args: null, resumeFromRunId: failed.id },
            testHost(),
          );
          yield* reportTask(fixture, "review the map", "Reviewed.");
          const done = yield* finished(workflows, resumed.id);
          expect(resultValue(done)).toEqual(["Mapped.", "Reviewed."]);
          expect(done.reused).toBe(1);
        }),
      );
    },
  );

  it.live("rejects resuming a run that is still running", () => {
    const fixture = workflowFixture();
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const running = yield* workflows.start(
          { source: inline('return await agent("slow");'), args: null },
          testHost(),
        );
        const rejected = yield* workflows
          .start(
            { source: inline("return 1;"), args: null, resumeFromRunId: running.id },
            testHost(),
          )
          .pipe(Effect.flip);
        expect(rejected._tag).toBe("WorkflowRequestError");
      }),
    );
  });
});

describe("workflow agents", () => {
  it.live("runs nested saved workflows under prefixed phases", () => {
    const fixture = workflowFixture({
      scripts: {
        child: script('phase("Scan"); return args.n * 2;', "child"),
      },
    });
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          {
            source: inline('phase("Prepare"); return await workflow("child", { n: 21 });'),
            args: null,
          },
          testHost(),
        );
        const run = yield* finished(workflows, started.id);
        expect(run.result?.text).toBe("42");
        expect(run.phases.map((phase) => phase.title)).toEqual([
          "Main",
          "Prepare",
          "▸ child · Main",
          "▸ child · Scan",
        ]);
        expect(run.currentPhase).toBe("▸ child · Scan");
      }),
    );
  });

  it.live("isolates a writer in a worktree and lists it in the notification", () => {
    const requests: StartSubagentRequest[] = [];
    const fixture = workflowFixture({ worktrees: true });
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          {
            source: inline(
              'return await agent("fix the bug", { profile: "worker", isolation: "worktree" });',
            ),
            args: null,
          },
          testHost((request) => requests.push(request)),
        );
        yield* reportTask(fixture, "fix the bug", "Fixed.");
        const run = yield* finished(workflows, started.id);
        const workspaceId = run.agents[0]?.workspaceId;
        expect(workspaceId).toBeDefined();
        const writer = fixture.projections.at(-1)?.runs.find((view) => view.task === "fix the bug");
        expect(writer?.writerWorkspaceMode).toBe("worktree");
        yield* eventually(() => fixture.delivered[0], "the notification");
        expect(fixture.workflowNotifications[0]?.workspaces).toEqual([workspaceId]);
        expect(requests).toHaveLength(1);
      }),
    );
  });

  it.live("attaches a result contract for schema calls and returns the parsed value", () => {
    const fixture = workflowFixture();
    return withWorkflows(fixture, (workflows, subagents) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          {
            source: inline(`
              const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
              const value = await agent("structured", { schema });
              return { value, kind: typeof value };`),
            args: null,
          },
          testHost(),
        );
        const runId = yield* reportTask(fixture, "structured", '{"ok":true}');
        const run = yield* finished(workflows, started.id);
        expect(resultValue(run)).toEqual({ value: { ok: true }, kind: "object" });
        expect(runId).toBeDefined();
        expect(subagents).toBeDefined();
      }),
    );
  });

  it.live("keeps waiting while a workflow agent asks the main agent a question", () => {
    const fixture = workflowFixture({
      backend: fakeNativeReportBackendLayer({
        capabilities: ["steer", "interrupt", "resume", "rename-display", "parent-contact"],
      }),
    });
    return withWorkflows(fixture, (workflows, subagents) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          { source: inline('return await agent("needs input");'), args: null },
          testHost(),
        );
        const runId = yield* runningTask(fixture, "needs input");
        const control = fixture.backend.controls[0]!;
        control.offer({
          type: "supervisor_contact",
          assignmentEpoch: 1,
          requestId: "question-1",
          kind: "question",
          message: "Which module?",
        });
        yield* eventually(
          () => (stateOfTask(fixture, "needs input") === "waiting_for_parent" ? true : undefined),
          "the question",
        );
        yield* subagents.reply(runId, "The auth module.");
        control.report(runId, 1, "answered", "Auth reviewed.");
        const run = yield* finished(workflows, started.id);
        expect(run.result?.text).toBe("Auth reviewed.");
      }),
    );
  });
});
