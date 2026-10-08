// Explicit test entry-point Layer provision owns each scoped service runtime.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import type { SubagentServiceContract } from "../../src/run/service.ts";
import {
  WORKFLOW_AGENT_LABEL_MAX_CHARS,
  WORKFLOW_LOG_LIMIT,
  WORKFLOW_PHASE_TITLE_MAX_CHARS,
} from "../../src/workflow/model.ts";
import type { WorkflowServiceContract } from "../../src/workflow/service.ts";
import {
  controlForTask,
  deliveredFor,
  eventually,
  finished,
  inWorkflows,
  onceSettled,
  reportTask,
  resultValue,
  runningTask,
  runRecord,
  runWhere,
  startScript,
  until,
  withJournal,
  withWorkflows,
  type WorkflowFixture,
  workflowFixture,
  workflowSessionKey,
  workflowTest,
  worktreeWriter,
} from "./fixtures/workflow-harness.ts";

const WORKTREE_WRITER = `const fixed = await ${worktreeWriter("fix the bug")};`;

/** Runs a worktree writer, then fails the script; returns the run and the writer's worktree. */
const failAfterWorktreeWriter = (fixture: WorkflowFixture, workflows: WorkflowServiceContract) =>
  Effect.gen(function* () {
    const original = yield* startScript(
      workflows,
      `${WORKTREE_WRITER}\nthrow new Error("not yet");`,
    );
    yield* reportTask(fixture, "fix the bug", "Fixed.");
    const failed = yield* finished(workflows, original.id);
    expect(failed.state).toBe("failed");
    const workspaceId = failed.agents[0]?.workspaceId;
    expect(workspaceId).toBeDefined();
    return { runId: original.id, workspaceId: workspaceId ?? "" };
  });

/** Like `failAfterWorktreeWriter`, then integrates the writer's worktree as the main agent. */
const failAfterIntegratedWriter = (
  fixture: WorkflowFixture,
  workflows: WorkflowServiceContract,
  subagents: SubagentServiceContract,
) =>
  Effect.gen(function* () {
    const original = yield* failAfterWorktreeWriter(fixture, workflows);
    const review = yield* onceSettled(subagents.workspaceReview(original.workspaceId));
    expect(review.nextOffset).toBeUndefined();
    const prepared = yield* subagents.workspacePrepare(original.workspaceId, review.revisionId);
    yield* subagents.workspaceIntegrate(
      original.workspaceId,
      review.revisionId,
      prepared.preparationId,
    );
    return original;
  });

/** Resumes `runId` with a script that runs a reader after the writer; returns the new run's id. */
const resumeWithChecker = (workflows: WorkflowServiceContract, runId: string) =>
  startScript(workflows, `${WORKTREE_WRITER}\nreturn [fixed, await agent("check it")];`, {
    resumeFromRunId: runId,
  }).pipe(Effect.map((resumed) => resumed.id));

/** Agents take a while to stop, which leaves a stop waiting long enough to interrupt. */
const slowToStop = (service: SubagentServiceContract): SubagentServiceContract => ({
  ...service,
  closeOwner: (ownerId) =>
    Effect.sleep("300 millis").pipe(Effect.andThen(service.closeOwner(ownerId))),
});

describe("workflow stops", () => {
  it.live("notifies about a stop whose tool call ended before the run stopped", () =>
    workflowTest({ worktrees: true, decorate: slowToStop }, function* ({ fixture, workflows }) {
      const started = yield* startScript(workflows, `return await ${worktreeWriter("fix")};`);
      yield* runningTask(fixture, "fix");
      const stopping = yield* workflows.stop(started.id, "tool").pipe(Effect.forkChild);
      yield* runWhere(workflows, started.id, (run) => run.state === "stopping");
      // The user interrupts the stop call, so its result never reaches the main agent.
      yield* Fiber.interrupt(stopping);
      const run = yield* finished(workflows, started.id);
      expect(run.state).toBe("stopped");
      const notification = yield* eventually(() => fixture.delivered[0], "the stop notification");
      expect(notification).toMatchObject({ outcome: "stopped", workspaces: ["workspace-1"] });
      expect(notification.content).not.toContain("resumeFromRunId");
    }),
  );

  it.live("keeps the first stop's origin whatever later stop calls ask", () =>
    workflowTest({ decorate: slowToStop }, function* ({ fixture, workflows }) {
      const started = yield* startScript(workflows, 'return await agent("long");');
      yield* runningTask(fixture, "long");
      const first = yield* workflows.stop(started.id, "tool").pipe(Effect.forkChild);
      yield* until(
        () => runRecord(fixture.runFiles, started.id)?.["stoppedBy"] === "tool",
        "the first stop's origin",
      );
      // Another stop call joins the first and ends before the run stops, then the user's joins;
      // each enters the stop before this fiber goes on.
      const joining = Effect.forkChild({ startImmediately: true });
      yield* Fiber.interrupt(yield* workflows.stop(started.id, "tool").pipe(joining));
      const user = yield* workflows.stop(started.id, "user").pipe(joining);
      expect(runRecord(fixture.runFiles, started.id)).toMatchObject({ stoppedBy: "tool" });
      // The first call still returns the final state, so the run sends no notification.
      expect(yield* Fiber.join(first)).toMatchObject({ state: "stopped", stoppedBy: "tool" });
      yield* Fiber.join(user);
      yield* Effect.sleep("50 millis");
      expect(fixture.workflowNotifications).toEqual([]);
    }),
  );

  it.live("records the user's stop after the main agent's stop call ended early", () =>
    workflowTest({ decorate: slowToStop }, function* ({ fixture, workflows }) {
      const started = yield* startScript(workflows, 'return await agent("long");');
      yield* runningTask(fixture, "long");
      const tool = yield* workflows.stop(started.id, "tool").pipe(Effect.forkChild);
      yield* runWhere(workflows, started.id, (run) => run.state === "stopping");
      // The user interrupts the main agent's stop call, then stops the run themselves.
      yield* Fiber.interrupt(tool);
      yield* workflows.stop(started.id, "user");
      // Once the run leaves memory, its record then offers no restart.
      expect(runRecord(fixture.runFiles, started.id)).toMatchObject({
        state: "stopped",
        stoppedBy: "user",
      });
    }),
  );

  it.live("keeps the script's console output when it is stopped", () =>
    workflowTest({}, function* ({ fixture, workflows }) {
      const started = yield* startScript(
        workflows,
        'console.log("hello from console"); log("event log"); await agent("long task");',
      );
      yield* runningTask(fixture, "long task");
      const stopped = yield* workflows.stop(started.id, "tool");
      expect(stopped.logs.map((entry) => entry.message)).toEqual([
        "event log",
        "hello from console",
      ]);
    }),
  );
});

describe("workflow agent display options", () => {
  it.live("treats a null label or phase as omitted", () =>
    workflowTest({}, function* ({ fixture, workflows }) {
      const started = yield* startScript(
        workflows,
        'phase("Find"); return await agent("task one", { label: null, phase: null });',
      );
      yield* reportTask(fixture, "task one", "found");
      const run = yield* finished(workflows, started.id);
      expect(run.state).toBe("completed");
      expect(run.agents[0]).toMatchObject({ label: "agent-1", phase: "Find" });
    }),
  );

  it.live("clips a long label and phase title instead of rejecting the call", () =>
    workflowTest({}, function* ({ fixture, workflows }) {
      const started = yield* startScript(
        workflows,
        `
        phase("x".repeat(300));
        return await agent("task one", { label: "verify: " + "claim ".repeat(30) });`,
      );
      yield* reportTask(fixture, "task one", "verified");
      const run = yield* finished(workflows, started.id);
      expect(run.state).toBe("completed");
      expect(run.result?.text).toBe("verified");
      const agent = run.agents[0]!;
      expect(agent.label.length).toBeLessThanOrEqual(WORKFLOW_AGENT_LABEL_MAX_CHARS);
      expect(agent.phase).toBe(run.currentPhase);
      expect(agent.phase!.length).toBeLessThanOrEqual(WORKFLOW_PHASE_TITLE_MAX_CHARS);
    }),
  );
});

describe("workflow results", () => {
  it.live(
    "keeps warnings in a completed run's notification after later log lines evicted them",
    () =>
      workflowTest({}, function* ({ fixture, workflows }) {
        const started = yield* startScript(
          workflows,
          `
        const results = await parallel([() => { throw new RangeError("no colour for this item"); }]);
        for (let index = 0; index < ${WORKFLOW_LOG_LIMIT + 10}; index++) log("progress " + index);
        return results;`,
        );
        const run = yield* finished(workflows, started.id);
        expect(run.logs.some((entry) => entry.level === "warning")).toBe(false);
        const notification = yield* eventually(() => fixture.delivered[0], "the notification");
        expect(notification.outcome).toBe("completed");
        expect(notification.content).toContain("no colour for this item");
      }),
  );

  it.live("saves a result that would push the notification past its limit", () =>
    workflowTest({}, function* ({ fixture, workflows }) {
      const fs = yield* FileSystem.FileSystem;
      // Twelve long warnings take room the 27 KiB result would otherwise use.
      const started = yield* startScript(
        workflows,
        `
        await parallel(Array.from({ length: 12 }, (_, index) => () => {
          throw new Error(index + ": " + "w".repeat(1500));
        }));
        return "head" + "x".repeat(27 * 1024) + "tail";`,
      );
      const run = yield* finished(workflows, started.id);
      const notification = yield* eventually(() => fixture.delivered[0], "the notification");
      expect(notification.content.length).toBeLessThanOrEqual(32 * 1024);
      expect(run.result?.clipped).toBe(true);
      const path = run.result?.path;
      expect(path).toBeDefined();
      expect(notification.content).toContain(path!);
      const saved = yield* fs.readFileString(path!);
      yield* fs.remove(path!);
      expect(saved).toHaveLength(27 * 1024 + 8);
      expect(saved.endsWith("tail")).toBe(true);
    }),
  );
});

describe("workflow teardown", () => {
  it.live("posts one notice per run an earlier activation of the session left running", () => {
    const sessionKey = workflowSessionKey();
    const first = workflowFixture({ sessionKey, worktrees: true });
    return Effect.gen(function* () {
      const runId = yield* inWorkflows(first, function* ({ workflows }) {
        const started = yield* startScript(
          workflows,
          `const done = await ${worktreeWriter("first")};\nreturn [done, await agent("second")];`,
        );
        yield* reportTask(first, "first", "first done");
        yield* runningTask(first, "second");
        return started.id;
      });
      expect(first.workflowNotifications).toEqual([]);

      const second = workflowFixture({ sessionKey });
      yield* inWorkflows(second, function* () {
        const notice = yield* eventually(() => second.delivered[0], "the interrupted notice");
        expect(notice).toMatchObject({
          runId,
          outcome: "interrupted",
          agents: expect.objectContaining({ total: 1 }),
          workspaces: [expect.any(String)],
        });
        expect(notice.content).toContain(`resumeFromRunId: "${runId}"`);
      });
      expect(second.workflowNotifications).toHaveLength(1);

      const third = workflowFixture({ sessionKey });
      yield* withWorkflows(third, () => Effect.sleep("50 millis"));
      expect(third.workflowNotifications).toEqual([]);
    });
  });

  it.live("reports a run that was being stopped at teardown without offering a restart", () => {
    const sessionKey = workflowSessionKey();
    const first = workflowFixture({ sessionKey, decorate: slowToStop });
    return Effect.gen(function* () {
      const runId = yield* inWorkflows(first, function* ({ workflows }) {
        const started = yield* startScript(workflows, 'return await agent("long");');
        yield* runningTask(first, "long");
        yield* workflows.stop(started.id).pipe(Effect.forkScoped);
        yield* runWhere(workflows, started.id, (run) => run.state === "stopping");
        return started.id;
      });
      expect(first.workflowNotifications).toEqual([]);
      yield* workflowTest({ sessionKey }, function* ({ fixture }) {
        const notice = yield* eventually(() => fixture.delivered[0], "the teardown notice");
        expect(notice.runId).toBe(runId);
        expect(notice.content).not.toContain("resumeFromRunId");
      });
    });
  });

  it.live("announces a finished run whose notification a teardown kept from arriving", () => {
    const sessionKey = workflowSessionKey();
    const first = workflowFixture({ sessionKey, accept: () => false });
    return Effect.gen(function* () {
      const runId = yield* inWorkflows(first, function* ({ workflows }) {
        const started = yield* startScript(workflows, 'return "done";');
        yield* finished(workflows, started.id);
        yield* eventually(() => first.workflowNotifications[0], "a refused delivery");
        return started.id;
      });
      expect(first.delivered).toEqual([]);
      yield* workflowTest({ sessionKey }, function* ({ fixture }) {
        const notice = yield* eventually(() => fixture.delivered[0], "the teardown notice");
        expect(notice).toMatchObject({ runId, outcome: "interrupted" });
      });
      const third = workflowFixture({ sessionKey });
      yield* withWorkflows(third, () => Effect.sleep("50 millis"));
      expect(third.workflowNotifications).toEqual([]);
    });
  });

  it.live("runs a worktree writer again when resuming a run from an earlier activation", () => {
    const sessionKey = workflowSessionKey();
    const first = workflowFixture({ sessionKey, worktrees: true });
    return Effect.gen(function* () {
      const original = yield* inWorkflows(first, function* ({ workflows }) {
        const original = yield* failAfterWorktreeWriter(first, workflows);
        yield* eventually(() => first.delivered[0], "the failure notification");
        return original;
      });

      // A later activation can't review the first one's worktree, so it doesn't reuse it.
      yield* workflowTest({ sessionKey, worktrees: true }, function* ({ fixture, workflows }) {
        const resumed = yield* startScript(workflows, `${WORKTREE_WRITER}\nreturn fixed;`, {
          resumeFromRunId: original.runId,
        });
        yield* reportTask(fixture, "fix the bug", "Fixed again.");
        const run = yield* finished(workflows, resumed.id);
        expect(run.result?.text).toBe("Fixed again.");
        expect(run.reused).toBe(0);
        expect(run.reusedWorkspaces).toBeUndefined();
      });
    });
  });

  it.live("lists the worktrees of reused writer calls when a run is resumed", () =>
    workflowTest({ worktrees: true }, function* ({ fixture, workflows }) {
      const original = yield* failAfterWorktreeWriter(fixture, workflows);
      const resumedId = yield* resumeWithChecker(workflows, original.runId);
      yield* reportTask(fixture, "check it", "Checked.");
      const run = yield* finished(workflows, resumedId);
      expect(resultValue(run)).toEqual(["Fixed.", "Checked."]);
      expect(run.reused).toBe(1);
      const notification = yield* deliveredFor(fixture, resumedId);
      expect(notification.workspaces).toEqual([original.workspaceId]);
      expect(notification.content).toContain(original.workspaceId);
    }),
  );

  it.live("runs a writer again on resume when the main agent discarded its worktree", () =>
    workflowTest({ worktrees: true }, function* ({ fixture, workflows, subagents }) {
      const original = yield* failAfterWorktreeWriter(fixture, workflows);
      yield* onceSettled(subagents.workspaceDiscard(original.workspaceId));

      const resumedId = yield* resumeWithChecker(workflows, original.runId);
      yield* reportTask(fixture, "fix the bug", "Fixed again.");
      yield* reportTask(fixture, "check it", "Checked.");
      const run = yield* finished(workflows, resumedId);
      expect(resultValue(run)).toEqual(["Fixed again.", "Checked."]);
      expect(run.reused).toBe(0);
      expect(run.logs.some((entry) => entry.message.includes(original.workspaceId))).toBe(true);
      const notification = yield* deliveredFor(fixture, resumedId);
      // Only the new writer's worktree awaits review.
      expect(notification.workspaces).toHaveLength(1);
      expect(notification.workspaces).not.toContain(original.workspaceId);
    }),
  );

  it.live("reuses an integrated writer's result on resume without proposing its worktree", () =>
    workflowTest({ worktrees: true }, function* ({ fixture, workflows, subagents }) {
      const original = yield* failAfterIntegratedWriter(fixture, workflows, subagents);
      const resumedId = yield* resumeWithChecker(workflows, original.runId);
      yield* reportTask(fixture, "check it", "Checked.");
      const run = yield* finished(workflows, resumedId);
      expect(resultValue(run)).toEqual(["Fixed.", "Checked."]);
      expect(run.reused).toBe(1);
      expect(run.reusedWorkspaces).toBeUndefined();
      const notification = yield* deliveredFor(fixture, resumedId);
      expect(notification.workspaces).toEqual([]);
    }),
  );

  it.live("leaves a reused integrated writer's worktree out of a teardown notice", () => {
    const sessionKey = workflowSessionKey();
    return Effect.gen(function* () {
      const resumedId = yield* workflowTest(
        { sessionKey, worktrees: true },
        function* ({ fixture, workflows, subagents }) {
          const original = yield* failAfterIntegratedWriter(fixture, workflows, subagents);
          const resumedId = yield* resumeWithChecker(workflows, original.runId);
          // The writer was reused; the session tears down while the checker still runs.
          yield* runningTask(fixture, "check it");
          return resumedId;
        },
      );
      const remembered = yield* withJournal(sessionKey, (journal) => journal.interruptedRuns);
      expect(remembered).toEqual([
        expect.objectContaining({ runId: resumedId, finished: 1, workspaces: [] }),
      ]);
    });
  });
});

describe("workflow writers after the workflow", () => {
  it.live("revises a workflow writer's worktree as the main agent's own run", () =>
    workflowTest({ worktrees: true }, function* ({ fixture, workflows, subagents }) {
      const started = yield* startScript(
        workflows,
        `
        const schema = { type: "object", properties: { fixed: { type: "boolean" } }, required: ["fixed"], additionalProperties: false };
        return await agent("fix lint", { profile: "worker", isolation: "worktree", schema });`,
      );
      yield* reportTask(fixture, "fix lint", '{"fixed":true}');
      const run = yield* finished(workflows, started.id);
      expect(resultValue(run)).toEqual({ fixed: true });
      const workspaceId = run.agents[0]!.workspaceId!;

      const successor = yield* subagents.workspaceRevise(workspaceId, "also update the tests");
      expect(successor.workflow).toBeUndefined();
      const control = yield* controlForTask(
        fixture,
        "fix lint\n\nParent revision request:\nalso update the tests",
      );
      control.report(successor.id, 1, "revision", "Updated the tests too.");
      const completion = yield* eventually(
        () =>
          fixture.rootNotifications
            .flatMap((notification) => (notification.type === "completed" ? notification.runs : []))
            .find((candidate) => candidate.id === successor.id),
        "the successor's report",
      );
      expect(completion).toMatchObject({
        outcome: "completed",
        finalText: "Updated the tests too.",
      });
    }),
  );
});
