// Explicit test entry-point Layer provision owns each scoped service runtime.
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { subagentErrorCode, type SubagentError } from "../../src/run/errors.ts";
import { workflowUnchangedWorkspaces } from "../../src/workflow/model.ts";
import {
  controlForTask,
  eventually,
  fakeGate,
  finished,
  inline,
  journalLines,
  leaveInWorktree,
  memoryRunFiles,
  reportTask,
  resultValue,
  runningTask,
  runWhere,
  stateOfTask,
  testHost,
  withWorkflows,
  workflowFixture,
  workflowSessionKey,
} from "./fixtures/workflow-harness.ts";
import { nativeReportRequest } from "../run/fixtures/service-harness.ts";

const writer = (task: string) =>
  `await agent(${JSON.stringify(task)}, { profile: "worker", isolation: "worktree" })`;

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

describe("workflow worktree writers that make no changes", () => {
  it.live("discards their worktrees and lists only the proposals that hold changes", () => {
    const fixture = workflowFixture({ worktrees: true });
    return withWorkflows(fixture, (workflows, subagents) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          {
            source: inline(
              `return [${writer("migrate a")}, ${writer("migrate b")}, ${writer("migrate c")}];`,
            ),
            args: null,
          },
          testHost(),
        );
        const unchangedA = yield* leaveInWorktree(fixture, "migrate a", "unchanged");
        yield* reportTask(fixture, "migrate a", "No change needed.");
        const changed = yield* leaveInWorktree(fixture, "migrate b", "changed");
        yield* reportTask(fixture, "migrate b", "Migrated.");
        const unchangedC = yield* leaveInWorktree(fixture, "migrate c", "unchanged");
        yield* reportTask(fixture, "migrate c", "No change needed.");

        const run = yield* finished(workflows, started.id);
        expect(resultValue(run)).toEqual(["No change needed.", "Migrated.", "No change needed."]);
        expect(run.agents.map((agent) => agent.unchanged === true)).toEqual([true, false, true]);
        expect(workflowUnchangedWorkspaces(run)).toBe(2);
        expect(yield* subagents.workspaceBindingStatus(unchangedA)).toBe("closed");
        expect(yield* subagents.workspaceBindingStatus(unchangedC)).toBe("closed");
        expect(yield* subagents.workspaceBindingStatus(changed)).toBe("pending");

        const notification = yield* eventually(
          () => fixture.delivered.find((candidate) => candidate.runId === started.id),
          "the run's notification",
        );
        expect(notification.workspaces).toEqual([changed]);
        expect(notification.content).toContain(changed);
        expect(notification.content).not.toContain(unchangedA);
        expect(notification.content).not.toContain(unchangedC);

        const lines = journalLines(fixture.runFiles, run.journalPath);
        expect(lines.map((line) => [line.workspaceId, line.unchanged ?? false])).toEqual([
          [unchangedA, true],
          [changed, false],
          [unchangedC, true],
        ]);
      }),
    );
  });

  it.live("keeps a proposal with one warning when its check or its discard fails", () => {
    const fixture = workflowFixture({ worktrees: true });
    return withWorkflows(fixture, (workflows, subagents) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          {
            source: inline(`return [${writer("migrate a")}, ${writer("migrate b")}];`),
            args: null,
          },
          testHost(),
        );
        const unreadable = yield* leaveInWorktree(fixture, "migrate a", "unreadable");
        yield* reportTask(fixture, "migrate a", "Migrated.");
        const undeletable = yield* leaveInWorktree(fixture, "migrate b", "undeletable");
        yield* reportTask(fixture, "migrate b", "No change needed.");

        const run = yield* finished(workflows, started.id);
        expect(run.state).toBe("completed");
        expect(workflowUnchangedWorkspaces(run)).toBe(0);
        const warningsFor = (workspaceId: string) =>
          (run.warnings ?? []).filter((entry) => entry.message.includes(workspaceId));
        for (const workspaceId of [unreadable, undeletable]) {
          expect(yield* subagents.workspaceBindingStatus(workspaceId)).toBe("pending");
          expect(warningsFor(workspaceId)).toHaveLength(1);
        }
        // A discard that failed after a clean check sends the main agent to discard it instead.
        expect(warningsFor(undeletable)[0]?.message).toContain("subagent_workspace");
        expect(warningsFor(unreadable)[0]?.message).not.toContain("subagent_workspace");
        const notification = yield* eventually(
          () => fixture.delivered.find((candidate) => candidate.runId === started.id),
          "the run's notification",
        );
        expect(notification.workspaces).toEqual([unreadable, undeletable]);
      }),
    );
  });

  it.live("keeps the proposal of a writer whose worktree another run still works in", () => {
    const fixture = workflowFixture({ worktrees: true });
    return withWorkflows(fixture, (workflows, subagents) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          { source: inline(`return ${writer("migrate a")};`), args: null },
          testHost(),
        );
        const workspaceId = yield* leaveInWorktree(fixture, "migrate a", "unchanged");
        // A reader the writer started works in its worktree and outlives the writer.
        const writerRunId = yield* runningTask(fixture, "migrate a");
        yield* subagents.startSessionOwnedFrom(
          writerRunId,
          nativeReportRequest({ task: "read the call site", name: "reader" }),
        );
        yield* runningTask(fixture, "read the call site");
        yield* reportTask(fixture, "migrate a", "No change needed.");

        const run = yield* finished(workflows, started.id);
        expect(run.agents[0]?.unchanged).toBeUndefined();
        expect(yield* subagents.workspaceBindingStatus(workspaceId)).toBe("pending");
        const notification = yield* eventually(
          () => fixture.delivered.find((candidate) => candidate.runId === started.id),
          "the run's notification",
        );
        expect(notification.workspaces).toEqual([workspaceId]);
      }),
    );
  });

  it.live("finishes a check already under way when the run stops", () => {
    const fixture = workflowFixture({ worktrees: true });
    return withWorkflows(fixture, (workflows, subagents) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          { source: inline(`return ${writer("migrate a")};`), args: null },
          testHost(),
        );
        const workspaceId = yield* leaveInWorktree(fixture, "migrate a", "unchanged");
        const gate = yield* fakeGate;
        fixture.checkGates.set(workspaceId, gate);
        yield* reportTask(fixture, "migrate a", "No change needed.");
        yield* Deferred.await(gate.entered);

        const stopping = yield* workflows.stop(started.id).pipe(Effect.forkChild);
        yield* runWhere(workflows, started.id, (run) => run.state === "stopping");
        yield* Deferred.succeed(gate.release, undefined);
        const run = yield* Fiber.join(stopping);
        // The discarded worktree is recorded as such, never left listed for review.
        expect(run.agents[0]?.unchanged).toBe(true);
        expect(yield* subagents.workspaceBindingStatus(workspaceId)).toBe("closed");
      }),
    );
  });

  it.live("stops waiting for a turn to check once the run is asked to stop", () => {
    const fixture = workflowFixture({ worktrees: true });
    return withWorkflows(fixture, (_workflows, subagents) =>
      Effect.gen(function* () {
        const [first, second] = yield* Effect.forEach(["fix a", "fix b"], (task) =>
          Effect.gen(function* () {
            const started = yield* subagents.start(
              nativeReportRequest({
                task,
                name: task.replace(" ", "-"),
                profile: "worker",
                writeIntent: "writer",
                writerWorkspaceModeOverride: "worktree",
              }),
            );
            const workspaceId = yield* leaveInWorktree(fixture, task, "unchanged");
            const control = yield* controlForTask(fixture, task);
            control.report(started.id, 1, `report-${started.id}`, "Nothing to fix.");
            return workspaceId;
          }),
        );
        const gate = yield* fakeGate;
        fixture.checkGates.set(first!, gate);
        const checking = yield* onceSettled(
          subagents.workspaceDiscardUnchanged(first!, yield* Deferred.make<void>()),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(gate.entered);

        // The second check waits for the first, which holds the turn, until the stop.
        const stop = yield* Deferred.make<void>();
        const waiting = yield* subagents
          .workspaceDiscardUnchanged(second!, stop)
          .pipe(Effect.forkChild);
        yield* Deferred.succeed(stop, undefined);
        expect(yield* Fiber.join(waiting)).toBe(false);
        expect(yield* subagents.workspaceBindingStatus(second!)).toBe("pending");

        yield* Deferred.succeed(gate.release, undefined);
        expect(yield* Fiber.join(checking)).toBe(true);
        expect(yield* subagents.workspaceBindingStatus(first!)).toBe("closed");
      }),
    );
  });

  for (const restart of [false, true])
    it.live(
      `reuses on resume a writer whose unchanged worktree was discarded${restart ? ", after a Pi restart" : ""}`,
      () => {
        const runFiles = memoryRunFiles();
        const sessionKey = workflowSessionKey();
        const first = workflowFixture({ worktrees: true, runFiles, sessionKey });
        return Effect.gen(function* () {
          const original = yield* withWorkflows(first, (workflows) =>
            Effect.gen(function* () {
              const started = yield* workflows.start(
                {
                  source: inline(
                    `const fixed = ${writer("fix the bug")};\nthrow new Error("not yet");`,
                  ),
                  args: null,
                },
                testHost(),
              );
              yield* leaveInWorktree(first, "fix the bug", "unchanged");
              yield* reportTask(first, "fix the bug", "Nothing to fix.");
              const failed = yield* finished(workflows, started.id);
              expect(failed.agents[0]?.unchanged).toBe(true);
              return failed;
            }),
          );
          const later = workflowFixture({ worktrees: true, runFiles, sessionKey, restart });
          yield* withWorkflows(later, (workflows) =>
            Effect.gen(function* () {
              const resumed = yield* workflows.start(
                {
                  source: inline(
                    `const fixed = ${writer("fix the bug")};\nreturn [fixed, await agent("check it")];`,
                  ),
                  args: null,
                  resumeFromRunId: original.id,
                },
                testHost(),
              );
              yield* reportTask(later, "check it", "Checked.");
              const run = yield* finished(workflows, resumed.id);
              // Nothing of the writer's awaits review, so it isn't listed as a proposal either.
              expect(resultValue(run)).toEqual(["Nothing to fix.", "Checked."]);
              expect(run.reused).toBe(1);
              expect(run.reusedWorkspaces ?? []).toEqual([]);
              expect(stateOfTask(later, "fix the bug")).toBeUndefined();
            }),
          );
        });
      },
    );

  it.live("leaves the unchanged worktree of a writer the main agent started for review", () => {
    const fixture = workflowFixture({ worktrees: true });
    return withWorkflows(fixture, (_workflows, subagents) =>
      Effect.gen(function* () {
        const started = yield* subagents.start(
          nativeReportRequest({
            task: "fix by hand",
            name: "fixer",
            profile: "worker",
            writeIntent: "writer",
            writerWorkspaceModeOverride: "worktree",
          }),
        );
        const workspaceId = yield* leaveInWorktree(fixture, "fix by hand", "unchanged");
        const control = yield* controlForTask(fixture, "fix by hand");
        control.report(started.id, 1, "report-fixer", "Nothing to fix.");
        const review = yield* onceSettled(subagents.workspaceReview(workspaceId));
        expect(review.workspaceId).toBe(workspaceId);
        expect(yield* subagents.workspaceBindingStatus(workspaceId)).toBe("pending");
      }),
    );
  });
});
