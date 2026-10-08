// Explicit test entry-point Layer provision owns each scoped service runtime.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { StartSubagentRequest } from "../../src/run/model.ts";
import { workflowStatusText } from "../../src/tools/workflow-format.ts";
import {
  controlForTask,
  eventually,
  fakeNativeReportBackendLayer,
  finished,
  inWorkflows,
  reportTask,
  resultValue,
  runningTask,
  runWhere,
  script,
  startScript,
  stateOfTask,
  testHost,
  workflowFixture,
  workflowTest,
  worktreeWriter,
  until,
} from "./fixtures/workflow-harness.ts";

describe("workflow runs", () => {
  it.live("returns the script value once its agents report and notifies the root once", () =>
    workflowTest({}, function* ({ fixture, workflows }) {
      const started = yield* startScript(
        workflows,
        'phase("Find"); const found = await agent("find bugs", { label: "finder" }); return { found, args };',
        { args: { scope: "src" } },
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

  it.live("queues agents beyond the run's concurrency and drains them as slots free", () =>
    workflowTest({ concurrency: 1 }, function* ({ fixture, workflows }) {
      const started = yield* startScript(
        workflows,
        'return await parallel(["one", "two", "three"].map((task) => () => agent(task)));',
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

  it.live("resolves failed, stopped and skipped agents to null and keeps the script going", () =>
    workflowTest({ concurrency: 2 }, function* ({ fixture, workflows, subagents }) {
      const started = yield* startScript(
        workflows,
        'const results = await parallel(["fails", "stopped", "skipped"].map((task) => () => agent(task, { label: task }))); return { results, after: "continued" };',
      );
      yield* runningTask(fixture, "fails");
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
    }),
  );

  it.live("rejects invalid agent() calls without starting an agent", () =>
    workflowTest({}, function* ({ fixture, workflows }) {
      const started = yield* startScript(
        workflows,
        `
        const errors = [];
        for (const options of [{ model: "opus" }, { profile: "unknown" }, { schema: { $ref: "#/x" } }, { colour: "red" }]) {
          try { await agent("task", options); } catch (error) { errors.push(error.message); }
        }
        return errors;`,
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

  it.live("stops agents the script left running when it returns", () =>
    workflowTest({}, function* ({ fixture, workflows }) {
      const started = yield* startScript(
        workflows,
        'agent("forgotten"); await agent("awaited"); return "early";',
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

  it.live("stop interrupts the script and stops its agents before reporting stopped", () =>
    workflowTest({}, function* ({ fixture, workflows }) {
      const started = yield* startScript(
        workflows,
        'return await parallel([() => agent("left"), () => agent("right")]);',
      );
      yield* runningTask(fixture, "left");
      yield* runningTask(fixture, "right");
      const stopped = yield* workflows.stop(started.id);
      expect(stopped).toMatchObject({ state: "stopped", stoppedBy: "user" });
      expect(stateOfTask(fixture, "left")).toBe("stopped");
      expect(stateOfTask(fixture, "right")).toBe("stopped");
      expect(stopped.agents.map((agent) => agent.state)).toEqual(["stopped", "stopped"]);
      // Stopping again is a no-op that returns the same final state.
      expect((yield* workflows.stop(started.id)).state).toBe("stopped");
      const notification = yield* eventually(() => fixture.delivered[0], "the stop notification");
      expect(fixture.workflowNotifications.map((n) => n.outcome)).toEqual(["stopped"]);
      // The user chose to stop it, so nothing asks the main agent to start it again.
      expect(notification.content).not.toContain("resumeFromRunId");
    }),
  );

  it.live("interrupts runs on session teardown without notifying", () => {
    const fixture = workflowFixture();
    return Effect.gen(function* () {
      yield* inWorkflows(fixture, function* ({ workflows }) {
        yield* startScript(workflows, 'return await agent("long");');
        yield* runningTask(fixture, "long");
      });
      expect(stateOfTask(fixture, "long")).toBe("stopped");
      expect(fixture.workflowNotifications).toEqual([]);
    });
  });

  it.live("reports a failed script with its error and how to resume", () =>
    workflowTest({}, function* ({ fixture, workflows }) {
      const started = yield* startScript(
        workflows,
        'log("starting"); throw new TypeError("bad input");',
      );
      const run = yield* finished(workflows, started.id);
      expect(run.state).toBe("failed");
      expect(run.failure).toMatchObject({
        kind: "script",
        name: "TypeError",
        message: "bad input",
      });
      yield* eventually(() => fixture.delivered[0], "the failure notification");
      const content = fixture.workflowNotifications[0]!.content;
      expect(content).toContain("bad input");
      expect(content).toContain(started.id);
    }),
  );

  it.live("rejects syntax errors, oversized args and unknown resumes before running", () =>
    workflowTest({}, function* ({ workflows }) {
      const syntax = yield* startScript(workflows, "return (;").pipe(Effect.flip);
      expect(syntax._tag).toBe("WorkflowScriptError");
      const large = yield* startScript(workflows, "return 1;", { args: "x".repeat(70_000) }).pipe(
        Effect.flip,
      );
      expect(large._tag).toBe("WorkflowRequestError");
      const unknown = yield* startScript(workflows, "return 1;", {
        resumeFromRunId: "wf-x-1",
      }).pipe(Effect.flip);
      expect(unknown._tag).toBe("WorkflowRequestError");
      expect(yield* workflows.list).toEqual([]);
    }),
  );
});

describe("workflow resume", () => {
  it.live("reuses identical earlier calls in order and runs changed calls live", () =>
    workflowTest({ concurrency: 1 }, function* ({ fixture, workflows }) {
      const first = yield* startScript(
        workflows,
        'return [await agent("same"), await agent("same", { label: "again" }), await agent("other")];',
      );
      yield* reportTask(fixture, "same", "first same");
      // The identical second call is a separate agent with the same task.
      yield* until(() => fixture.backend.controls.length === 2, "the second identical call");
      yield* reportTask(fixture, "same", "second same");
      yield* reportTask(fixture, "other", "other result");
      expect(resultValue(yield* finished(workflows, first.id))).toEqual([
        "first same",
        "second same",
        "other result",
      ]);

      const resumed = yield* startScript(
        workflows,
        'return [await agent("same"), await agent("same"), await agent("changed")];',
        { resumeFromRunId: first.id },
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

  it.live("runs the check again when only the shared-checkout writer before it changed", () => {
    const implementThenCheck = (task: string) =>
      `const fixed = await agent(${JSON.stringify(task)}, { profile: "worker" }); return [fixed, await agent("run the tests")];`;
    return workflowTest({}, function* ({ fixture, workflows }) {
      const first = yield* startScript(workflows, implementThenCheck("implement the fix"));
      yield* reportTask(fixture, "implement the fix", "Implemented.");
      yield* reportTask(fixture, "run the tests", "Tests fail.");
      expect((yield* finished(workflows, first.id)).state).toBe("completed");

      const resumed = yield* startScript(
        workflows,
        implementThenCheck("implement the fix properly"),
        { resumeFromRunId: first.id },
      );
      yield* reportTask(fixture, "implement the fix properly", "Implemented properly.");
      yield* reportTask(fixture, "run the tests", "Tests pass.");
      const run = yield* finished(workflows, resumed.id);
      expect(resultValue(run)).toEqual(["Implemented properly.", "Tests pass."]);
      expect(run.reused).toBe(0);
    });
  });

  it.live(
    "fails a run on an invalid call inside parallel() and reuses its agents on resume",
    () => {
      const source = (options: string) =>
        `const map = await agent("map the code"); return [map, ...(await parallel([() => agent("review the map", ${options})]))];`;
      return workflowTest({}, function* ({ fixture, workflows }) {
        const failed = yield* startScript(workflows, source('{ agentType: "Explore" }'));
        yield* reportTask(fixture, "map the code", "Mapped.");
        const run = yield* finished(workflows, failed.id);
        expect(run.state).toBe("failed");
        expect(run.failure?.message).toContain('profile: "scout"');
        expect(stateOfTask(fixture, "review the map")).toBeUndefined();
        const notification = yield* eventually(() => fixture.delivered[0], "the notification");
        expect(notification.outcome).toBe("failed");
        expect(notification.content).toContain(run.scriptPath ?? "the script copy");
        expect(notification.content).toContain(`resumeFromRunId: "${failed.id}"`);

        const resumed = yield* startScript(workflows, source('{ profile: "scout" }'), {
          resumeFromRunId: failed.id,
        });
        yield* reportTask(fixture, "review the map", "Reviewed.");
        const done = yield* finished(workflows, resumed.id);
        expect(resultValue(done)).toEqual(["Mapped.", "Reviewed."]);
        expect(done.reused).toBe(1);
      });
    },
  );

  it.live("rejects resuming a run that is still running", () =>
    workflowTest({}, function* ({ workflows }) {
      const running = yield* startScript(workflows, 'return await agent("slow");');
      const rejected = yield* startScript(workflows, "return 1;", {
        resumeFromRunId: running.id,
      }).pipe(Effect.flip);
      expect(rejected._tag).toBe("WorkflowRequestError");
    }),
  );
});

describe("workflow agents", () => {
  it.live("runs nested saved workflows under prefixed phases", () =>
    workflowTest(
      { scripts: { child: script('phase("Scan"); return args.n * 2;', "child") } },
      function* ({ workflows }) {
        const started = yield* startScript(
          workflows,
          'phase("Prepare"); return await workflow("child", { n: 21 });',
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
      },
    ),
  );

  it.live("isolates a writer in a worktree and lists it in the notification", () => {
    const requests: StartSubagentRequest[] = [];
    return workflowTest({ worktrees: true }, function* ({ fixture, workflows }) {
      const started = yield* startScript(
        workflows,
        `return await ${worktreeWriter("fix the bug")};`,
        {},
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
    });
  });

  it.live("attaches a result contract for schema calls and returns the parsed value", () =>
    workflowTest({}, function* ({ fixture, workflows }) {
      const started = yield* startScript(
        workflows,
        `
        const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
        const value = await agent("structured", { schema });
        return { value, kind: typeof value };`,
      );
      yield* reportTask(fixture, "structured", '{"ok":true}');
      const run = yield* finished(workflows, started.id);
      expect(resultValue(run)).toEqual({ value: { ok: true }, kind: "object" });
    }),
  );

  it.live("keeps waiting while a workflow agent asks the main agent a question", () =>
    workflowTest(
      {
        backend: fakeNativeReportBackendLayer({
          capabilities: ["steer", "interrupt", "resume", "rename-display", "parent-contact"],
        }),
      },
      function* ({ fixture, workflows, subagents }) {
        const started = yield* startScript(workflows, 'return await agent("needs input");');
        const runId = yield* runningTask(fixture, "needs input");
        const control = fixture.backend.controls[0]!;
        control.offer({
          type: "supervisor_contact",
          assignmentEpoch: 1,
          requestId: "question-1",
          kind: "question",
          message: "Which module?",
        });
        yield* until(
          () => stateOfTask(fixture, "needs input") === "waiting_for_parent",
          "the question",
        );
        // Status names the agent whose question waits for a reply, and how to answer it.
        const status = yield* workflows.status(started.id);
        if (status.kind !== "view") return yield* Effect.die(new Error("Expected a live run."));
        expect(status.attention).toMatchObject([
          { kind: "question", runId, message: "Which module?" },
        ]);
        const text = workflowStatusText(status.run, status.run.startedAt, status.attention);
        const line = text.split("\n").find((entry) => entry.includes("Which module?"));
        expect(line).toContain(runId);
        expect(line).toContain("subagent_reply");
        yield* subagents.reply(runId, "The auth module.");
        control.report(runId, 1, "answered", "Auth reviewed.");
        const run = yield* finished(workflows, started.id);
        expect(run.result?.text).toBe("Auth reviewed.");
      },
    ),
  );
});
