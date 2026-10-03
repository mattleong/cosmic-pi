// Explicit test entry-point Layer provision owns each scoped service runtime.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import { makeHostNotifier } from "../../src/boundary/host-notifier.ts";
import { subagentErrorCode, type SubagentError } from "../../src/run/errors.ts";
import type { SubagentServiceContract } from "../../src/run/service.ts";
import {
  WORKFLOW_AGENT_LABEL_MAX_CHARS,
  WORKFLOW_LOG_LIMIT,
  WORKFLOW_PHASE_TITLE_MAX_CHARS,
} from "../../src/workflow/model.ts";
import { WorkflowService, type WorkflowServiceContract } from "../../src/workflow/service.ts";
import { extensionApiFixture } from "../fixtures/pi-host.ts";
import {
  controlForTask,
  eventually,
  finished,
  reportTask,
  resultValue,
  runningTask,
  runWhere,
  script,
  stateOfTask,
  testHost,
  withWorkflows,
  workflowFixture,
  workflowSessionKey,
} from "./fixtures/workflow-harness.ts";

const inline = (body: string) => ({ kind: "inline" as const, script: script(body) });

const NOTIFICATION_MAX_CHARS = 32 * 1024;

/** Retries a root workspace operation until the writer's process cleanup is confirmed. */
const onceSettled = <A>(
  operation: Effect.Effect<A, SubagentError>,
): Effect.Effect<A, SubagentError> =>
  operation.pipe(
    Effect.catchIf(
      (error) => subagentErrorCode(error) === "workspace_process_unsettled",
      () =>
        Effect.sleep("5 millis").pipe(Effect.andThen(Effect.suspend(() => onceSettled(operation)))),
    ),
  );

const WORKTREE_WRITER =
  'const fixed = await agent("fix the bug", { profile: "worker", isolation: "worktree" });';

/** Runs a worktree writer, then fails the script; returns the run and the writer's worktree. */
const failAfterWorktreeWriter = (
  fixture: ReturnType<typeof workflowFixture>,
  workflows: WorkflowServiceContract,
) =>
  Effect.gen(function* () {
    const original = yield* workflows.start(
      { source: inline(`${WORKTREE_WRITER}\nthrow new Error("not yet");`), args: null },
      testHost(),
    );
    yield* reportTask(fixture, "fix the bug", "Fixed.");
    const failed = yield* finished(workflows, original.id);
    expect(failed.state).toBe("failed");
    const workspaceId = failed.agents[0]?.workspaceId;
    expect(workspaceId).toBeDefined();
    return { runId: original.id, workspaceId: workspaceId ?? "" };
  });

/** Resumes `runId` with a script that runs a reader after the writer; returns the new run's id. */
const resumeWithChecker = (workflows: WorkflowServiceContract, runId: string) =>
  workflows
    .start(
      {
        source: inline(`${WORKTREE_WRITER}\nreturn [fixed, await agent("check it")];`),
        args: null,
        resumeFromRunId: runId,
      },
      testHost(),
    )
    .pipe(Effect.map((resumed) => resumed.id));

/** Agents take a while to stop, which leaves a stop waiting long enough to interrupt. */
const slowToStop = (service: SubagentServiceContract): SubagentServiceContract => ({
  ...service,
  closeOwner: (ownerId) =>
    Effect.sleep("300 millis").pipe(Effect.andThen(service.closeOwner(ownerId))),
});

describe("workflow stops", () => {
  it.live("sends no notification for a stop the main agent asked for", () => {
    const fixture = workflowFixture();
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          { source: inline('return await agent("long");'), args: null },
          testHost(),
        );
        yield* runningTask(fixture, "long");
        const stopped = yield* workflows.stop(started.id, "tool");
        expect(stopped).toMatchObject({ state: "stopped", stoppedBy: "tool" });
        expect(stateOfTask(fixture, "long")).toBe("stopped");
        // Let any delivery fiber run before checking that none was started.
        yield* Effect.sleep("50 millis");
        expect(fixture.workflowNotifications).toEqual([]);
      }),
    );
  });

  it.live("tells the main agent the user stopped a run without asking it to start again", () => {
    const fixture = workflowFixture();
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          { source: inline('return await agent("long");'), args: null },
          testHost(),
        );
        yield* runningTask(fixture, "long");
        expect((yield* workflows.stop(started.id)).stoppedBy).toBe("user");
        const notification = yield* eventually(
          () => fixture.delivered[0],
          "the stopped notification",
        );
        expect(notification.outcome).toBe("stopped");
        expect(notification.content).not.toContain("resumeFromRunId");
      }),
    );
  });

  it.live("notifies about a stop whose tool call ended before the run stopped", () => {
    const fixture = workflowFixture({ worktrees: true, decorate: slowToStop });
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          {
            source: inline(
              'return await agent("fix", { profile: "worker", isolation: "worktree" });',
            ),
            args: null,
          },
          testHost(),
        );
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
  });

  it.live("keeps the script's console output when it is stopped", () => {
    const fixture = workflowFixture();
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          {
            source: inline(
              'console.log("hello from console"); log("event log"); await agent("long task");',
            ),
            args: null,
          },
          testHost(),
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
});

describe("workflow agent display options", () => {
  it.live("treats a null label or phase as omitted", () => {
    const fixture = workflowFixture();
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          {
            source: inline(`
              phase("Find");
              return await agent("task one", { label: null, phase: null });`),
            args: null,
          },
          testHost(),
        );
        yield* reportTask(fixture, "task one", "found");
        const run = yield* finished(workflows, started.id);
        expect(run.state).toBe("completed");
        expect(run.agents[0]).toMatchObject({ label: "agent-1", phase: "Find" });
      }),
    );
  });

  it.live("clips a long label and phase title instead of rejecting the call", () => {
    const fixture = workflowFixture();
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          {
            source: inline(`
              phase("x".repeat(300));
              return await agent("task one", { label: "verify: " + "claim ".repeat(30) });`),
            args: null,
          },
          testHost(),
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
});

describe("workflow results", () => {
  it.live("reports warnings with a completed run's result", () => {
    const fixture = workflowFixture();
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          {
            source: inline(`
              const results = await parallel([() => agent("task", { colour: "red" })]);
              return results;`),
            args: null,
          },
          testHost(),
        );
        yield* finished(workflows, started.id);
        const notification = yield* eventually(() => fixture.delivered[0], "the notification");
        expect(notification.outcome).toBe("completed");
        expect(notification.content).toContain("colour");
      }),
    );
  });

  it.live("keeps warnings in the notification after later log lines evicted them", () => {
    const fixture = workflowFixture();
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          {
            source: inline(`
              const results = await parallel([() => agent("task", { colour: "red" })]);
              for (let index = 0; index < ${WORKFLOW_LOG_LIMIT + 10}; index++) log("progress " + index);
              return results;`),
            args: null,
          },
          testHost(),
        );
        const run = yield* finished(workflows, started.id);
        expect(run.logs.some((entry) => entry.level === "warning")).toBe(false);
        const notification = yield* eventually(() => fixture.delivered[0], "the notification");
        expect(notification.content).toContain("colour");
      }),
    );
  });

  it.live("saves a result whose redaction would push it past the host's clip", () => {
    const sent: string[] = [];
    const fixture = workflowFixture({
      notify: makeHostNotifier(
        extensionApiFixture({
          sendMessage: (message: { readonly content: string }) => void sent.push(message.content),
        }),
      ),
    });
    return Effect.gen(function* () {
      const workflows = yield* WorkflowService;
      const fs = yield* FileSystem.FileSystem;
      // About 26 KiB, under the result budget, until redaction lengthens every line.
      const started = yield* workflows.start(
        {
          source: inline(
            'return Array.from({ length: 1300 }, (_, index) => "item " + index + " token=1").join("\\n") + "\\nEND";',
          ),
          args: null,
        },
        testHost(),
      );
      const run = yield* finished(workflows, started.id);
      const delivered = yield* eventually(() => sent[0], "the delivered notification");
      // The host delivered the content whole: nothing was cut after the saved file's path.
      expect(delivered).toBe(fixture.workflowNotifications[0]?.content);
      expect(delivered.endsWith("END")).toBe(true);
      expect(run.result?.clipped).toBe(true);
      const path = run.result?.path;
      expect(path).toBeDefined();
      expect(delivered).toContain(path!);
      yield* fs.remove(path!);
    }).pipe(Effect.scoped, Effect.provide(fixture.layer));
  });

  it.live("saves a result that would push the notification past its limit", () => {
    const fixture = workflowFixture();
    return Effect.gen(function* () {
      const workflows = yield* WorkflowService;
      const fs = yield* FileSystem.FileSystem;
      // Twelve long warnings take room the 27 KiB result would otherwise use.
      const started = yield* workflows.start(
        {
          source: inline(`
            await parallel(Array.from({ length: 12 }, (_, index) => () => {
              throw new Error(index + ": " + "w".repeat(1500));
            }));
            return "head" + "x".repeat(27 * 1024) + "tail";`),
          args: null,
        },
        testHost(),
      );
      const run = yield* finished(workflows, started.id);
      const notification = yield* eventually(() => fixture.delivered[0], "the notification");
      expect(notification.content.length).toBeLessThanOrEqual(NOTIFICATION_MAX_CHARS);
      expect(run.result?.clipped).toBe(true);
      const path = run.result?.path;
      expect(path).toBeDefined();
      expect(notification.content).toContain(path!);
      const saved = yield* fs.readFileString(path!);
      yield* fs.remove(path!);
      expect(saved).toHaveLength(27 * 1024 + 8);
    }).pipe(Effect.scoped, Effect.provide(fixture.layer));
  });
});

describe("workflow teardown", () => {
  it.live("posts one notice per run an earlier activation of the session left running", () => {
    const sessionKey = workflowSessionKey();
    const first = workflowFixture({ sessionKey, worktrees: true });
    return Effect.gen(function* () {
      const runId = yield* withWorkflows(first, (workflows) =>
        Effect.gen(function* () {
          const started = yield* workflows.start(
            {
              source: inline(`
                const done = await agent("first", { profile: "worker", isolation: "worktree" });
                return [done, await agent("second")];`),
              args: null,
            },
            testHost(),
          );
          yield* reportTask(first, "first", "first done");
          yield* runningTask(first, "second");
          return started.id;
        }),
      );
      expect(first.workflowNotifications).toEqual([]);

      const second = workflowFixture({ sessionKey });
      yield* withWorkflows(second, () =>
        Effect.gen(function* () {
          const notice = yield* eventually(() => second.delivered[0], "the interrupted notice");
          expect(notice).toMatchObject({
            runId,
            outcome: "interrupted",
            agents: expect.objectContaining({ total: 1 }),
            workspaces: [expect.any(String)],
          });
          expect(notice.content).toContain(`resumeFromRunId: "${runId}"`);
        }),
      );
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
      const runId = yield* withWorkflows(first, (workflows) =>
        Effect.gen(function* () {
          const started = yield* workflows.start(
            { source: inline('return await agent("long");'), args: null },
            testHost(),
          );
          yield* runningTask(first, "long");
          yield* workflows.stop(started.id).pipe(Effect.forkScoped);
          yield* runWhere(workflows, started.id, (run) => run.state === "stopping");
          return started.id;
        }),
      );
      expect(first.workflowNotifications).toEqual([]);

      const second = workflowFixture({ sessionKey });
      yield* withWorkflows(second, () =>
        Effect.gen(function* () {
          const notice = yield* eventually(() => second.delivered[0], "the teardown notice");
          expect(notice.runId).toBe(runId);
          expect(notice.content).not.toContain("resumeFromRunId");
        }),
      );
    });
  });

  it.live("announces a finished run whose notification a teardown kept from arriving", () => {
    const sessionKey = workflowSessionKey();
    const first = workflowFixture({ sessionKey, accept: () => false });
    return Effect.gen(function* () {
      const runId = yield* withWorkflows(first, (workflows) =>
        Effect.gen(function* () {
          const started = yield* workflows.start(
            { source: inline('return "done";'), args: null },
            testHost(),
          );
          yield* finished(workflows, started.id);
          yield* eventually(() => first.workflowNotifications[0], "a refused delivery");
          return started.id;
        }),
      );
      expect(first.delivered).toEqual([]);

      const second = workflowFixture({ sessionKey });
      yield* withWorkflows(second, () =>
        Effect.gen(function* () {
          const notice = yield* eventually(() => second.delivered[0], "the teardown notice");
          expect(notice).toMatchObject({ runId, outcome: "interrupted" });
        }),
      );
      const third = workflowFixture({ sessionKey });
      yield* withWorkflows(third, () => Effect.sleep("50 millis"));
      expect(third.workflowNotifications).toEqual([]);
    });
  });

  it.live("runs a worktree writer again when resuming a run from an earlier activation", () => {
    const sessionKey = workflowSessionKey();
    const writer =
      'const fixed = await agent("fix the bug", { profile: "worker", isolation: "worktree" });';
    const first = workflowFixture({ sessionKey, worktrees: true });
    return Effect.gen(function* () {
      const originalId = yield* withWorkflows(first, (workflows) =>
        Effect.gen(function* () {
          const original = yield* workflows.start(
            { source: inline(`${writer}\nthrow new Error("not yet");`), args: null },
            testHost(),
          );
          yield* reportTask(first, "fix the bug", "Fixed.");
          expect((yield* finished(workflows, original.id)).state).toBe("failed");
          yield* eventually(() => first.delivered[0], "the failure notification");
          return original.id;
        }),
      );

      // A later activation can't review the first one's worktree, so it doesn't reuse it.
      const second = workflowFixture({ sessionKey, worktrees: true });
      yield* withWorkflows(second, (workflows) =>
        Effect.gen(function* () {
          const resumed = yield* workflows.start(
            {
              source: inline(`${writer}\nreturn fixed;`),
              args: null,
              resumeFromRunId: originalId,
            },
            testHost(),
          );
          yield* reportTask(second, "fix the bug", "Fixed again.");
          const run = yield* finished(workflows, resumed.id);
          expect(run.result?.text).toBe("Fixed again.");
          expect(run.reused).toBe(0);
          expect(run.reusedWorkspaces).toBeUndefined();
        }),
      );
    });
  });

  it.live("counts reused results in their phase when a run is resumed", () => {
    const fixture = workflowFixture();
    const find = 'phase("Find"); const found = await agent("find it");';
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const original = yield* workflows.start(
          { source: inline(`${find}\nthrow new Error("not yet");`), args: null },
          testHost(),
        );
        yield* reportTask(fixture, "find it", "Found.");
        yield* finished(workflows, original.id);
        const resumed = yield* workflows.start(
          {
            source: inline(`${find}\nphase("Verify"); return found;`),
            args: null,
            resumeFromRunId: original.id,
          },
          testHost(),
        );
        const run = yield* finished(workflows, resumed.id);
        expect(run.agents).toEqual([]);
        expect(run.reusedPhases).toEqual([{ title: "Find", count: 1 }]);
      }),
    );
  });

  it.live("lists the worktrees of reused writer calls when a run is resumed", () => {
    const fixture = workflowFixture({ worktrees: true });
    const writer =
      'const fixed = await agent("fix the bug", { profile: "worker", isolation: "worktree" });';
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const original = yield* workflows.start(
          { source: inline(`${writer}\nthrow new Error("not yet");`), args: null },
          testHost(),
        );
        yield* reportTask(fixture, "fix the bug", "Fixed.");
        const failed = yield* finished(workflows, original.id);
        expect(failed.state).toBe("failed");
        const workspaceId = failed.agents[0]?.workspaceId;
        expect(workspaceId).toBeDefined();

        const resumed = yield* workflows.start(
          {
            source: inline(`${writer}\nreturn [fixed, await agent("check it")];`),
            args: null,
            resumeFromRunId: original.id,
          },
          testHost(),
        );
        yield* reportTask(fixture, "check it", "Checked.");
        const run = yield* finished(workflows, resumed.id);
        expect(resultValue(run)).toEqual(["Fixed.", "Checked."]);
        expect(run.reused).toBe(1);
        const notification = yield* eventually(
          () => fixture.delivered.find((candidate) => candidate.runId === resumed.id),
          "the resumed run's notification",
        );
        expect(notification.workspaces).toEqual([workspaceId]);
        expect(notification.content).toContain(workspaceId!);
      }),
    );
  });

  it.live("runs a writer again on resume when the main agent discarded its worktree", () => {
    const fixture = workflowFixture({ worktrees: true });
    return withWorkflows(fixture, (workflows, subagents) =>
      Effect.gen(function* () {
        const original = yield* failAfterWorktreeWriter(fixture, workflows);
        yield* onceSettled(subagents.workspaceDiscard(original.workspaceId));

        const resumedId = yield* resumeWithChecker(workflows, original.runId);
        yield* reportTask(fixture, "fix the bug", "Fixed again.");
        yield* reportTask(fixture, "check it", "Checked.");
        const run = yield* finished(workflows, resumedId);
        expect(resultValue(run)).toEqual(["Fixed again.", "Checked."]);
        expect(run.reused).toBe(0);
        expect(run.logs.some((entry) => entry.message.includes(original.workspaceId))).toBe(true);
        const notification = yield* eventually(
          () => fixture.delivered.find((candidate) => candidate.runId === resumedId),
          "the resumed run's notification",
        );
        // Only the new writer's worktree awaits review.
        expect(notification.workspaces).toHaveLength(1);
        expect(notification.workspaces).not.toContain(original.workspaceId);
      }),
    );
  });

  it.live("reuses an integrated writer's result on resume without proposing its worktree", () => {
    const fixture = workflowFixture({ worktrees: true });
    return withWorkflows(fixture, (workflows, subagents) =>
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

        const resumedId = yield* resumeWithChecker(workflows, original.runId);
        yield* reportTask(fixture, "check it", "Checked.");
        const run = yield* finished(workflows, resumedId);
        expect(resultValue(run)).toEqual(["Fixed.", "Checked."]);
        expect(run.reused).toBe(1);
        expect(run.reusedWorkspaces).toBeUndefined();
        const notification = yield* eventually(
          () => fixture.delivered.find((candidate) => candidate.runId === resumedId),
          "the resumed run's notification",
        );
        expect(notification.workspaces).toEqual([]);
      }),
    );
  });
});

describe("workflow writers after the workflow", () => {
  it.live("revises a workflow writer's worktree as the main agent's own run", () => {
    const fixture = workflowFixture({ worktrees: true });
    return withWorkflows(fixture, (workflows, subagents) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          {
            source: inline(`
              const schema = { type: "object", properties: { fixed: { type: "boolean" } }, required: ["fixed"], additionalProperties: false };
              return await agent("fix lint", { profile: "worker", isolation: "worktree", schema });`),
            args: null,
          },
          testHost(),
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
              .flatMap((notification) =>
                notification.type === "completed" ? notification.runs : [],
              )
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
});
