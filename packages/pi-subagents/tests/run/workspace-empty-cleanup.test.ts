import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { yieldUntil } from "pi-cosmic-core/testing";
import type { SubagentNotification } from "../../src/boundary/host-notifier.ts";
import type { SubagentServiceContract } from "../../src/run/service.ts";
import { WorkspaceError } from "../../src/workspace/model.ts";
import {
  acknowledgeCompletions,
  awaitRuns,
  completeLocalRun,
  request,
  reviewerContinuation,
  withService,
} from "./fixtures/service-harness.ts";
import {
  pauseAt,
  repoWriter,
  stoppedWriter,
  workspaceFixture,
} from "./fixtures/workspace-engine.ts";

type Fixture = ReturnType<typeof workspaceFixture>;

const unchanged = { changedPaths: [], uncapturedPaths: [], diffStat: [] };

const completedWriter = (service: SubagentServiceContract, f: Fixture) =>
  Effect.gen(function* () {
    const run = yield* service.start(repoWriter());
    yield* completeLocalRun(service, f.children.controls.at(-1)!, run.id, "Done.");
    return run;
  });

const outcomeOf = (service: SubagentServiceContract, id: string) =>
  service.list.pipe(Effect.map((runs) => runs.find((run) => run.id === id)?.workspaceOutcome));

const settledOutcome = (service: SubagentServiceContract, id: string) =>
  Effect.gen(function* () {
    for (let turn = 0; turn < 200; turn++) {
      const outcome = yield* outcomeOf(service, id);
      if (outcome) return outcome;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(new Error(`Workspace outcome of ${id} never settled.`));
  });

/** Counts inspections, so a test can tell the settlement probe ran or never started. */
const countInspections = (f: Fixture) => {
  const counter = { inspected: 0 };
  f.hooks.before.inspectWorkerChanges = Effect.sync(() => {
    counter.inspected += 1;
  });
  return counter;
};

const settleTurns = Effect.forEach(Array.from({ length: 50 }), () => Effect.yieldNow, {
  discard: true,
});

describe("empty worktree proposal cleanup", () => {
  it.effect(
    "discards a completed writer's unchanged workspace once its cleanup is confirmed",
    () => {
      const f = workspaceFixture();
      f.hooks.workerChanges = unchanged;
      return withService(f.layer, function* (service) {
        const writer = yield* completedWriter(service, f);
        const id = writer.workspaceId!;
        expect(yield* settledOutcome(service, writer.id)).toEqual({
          status: "auto-discarded",
        });
        expect(f.entries.get(id)?.status).toBe("discarded");
        expect(yield* service.workspaceReview(id).pipe(Effect.flip)).toMatchObject({
          code: "workspace_finished",
        });
        expect(
          yield* service
            .workspaceApply(id, { revisionId: "revision-1", preparationId: "prepared-1" })
            .pipe(Effect.flip),
        ).toMatchObject({ code: "workspace_finished" });
        const resumed = yield* service.resume(writer.id).pipe(Effect.flip);
        expect(resumed).toMatchObject({ code: "workspace_finished" });
        expect(resumed.message).toMatch(/automatically/u);
        expect(f.children.controls).toHaveLength(1);
      });
    },
  );

  it.effect("keeps a changed proposal and records its bounded diffstat until a resume", () => {
    const f = workspaceFixture();
    const changedPaths = Array.from({ length: 25 }, (_, index) => `src/file-${index}.ts`);
    f.hooks.workerChanges = {
      changedPaths,
      uncapturedPaths: [],
      diffStat: changedPaths.map((path, index) => ({
        path,
        change: "modified" as const,
        binary: index === 0,
        addedLines: index === 0 ? 0 : 2,
        deletedLines: index === 0 ? 0 : 1,
      })),
    };
    return withService(f.layer, function* (service) {
      const writer = yield* completedWriter(service, f);
      const outcome = yield* settledOutcome(service, writer.id);
      expect(outcome).toMatchObject({
        status: "proposal",
        changedFileCount: 25,
        diffStat: { addedLines: 48, deletedLines: 24 },
      });
      const files = outcome.status === "proposal" ? (outcome.diffStat?.files ?? []) : [];
      expect(files).toHaveLength(20);
      expect(files[0]).toEqual({
        path: "src/file-0.ts",
        addedLines: 0,
        deletedLines: 0,
        binary: true,
      });
      expect(f.entries.get(writer.workspaceId!)?.status).toBe("active");
      yield* service.resume(writer.id, "Also cover the edge case.");
      expect(yield* outcomeOf(service, writer.id)).toBeUndefined();
      yield* completeLocalRun(service, f.children.controls[1]!, writer.id, "Covered.");
      expect(yield* service.workspaceApply(writer.workspaceId!)).toMatchObject({
        integrated: true,
      });
    });
  });

  it.effect("keeps a writer whose only changes the proposal cannot capture", () => {
    const f = workspaceFixture();
    f.hooks.workerChanges = { changedPaths: [], uncapturedPaths: [".env"], diffStat: [] };
    return withService(f.layer, function* (service) {
      const writer = yield* completedWriter(service, f);
      expect(yield* settledOutcome(service, writer.id)).toEqual({
        status: "proposal",
        changedFileCount: 0,
        uncapturedFileCount: 1,
      });
      expect(f.entries.get(writer.workspaceId!)?.status).toBe("active");
    });
  });

  it.effect(
    "never probes failed or stopped writers, and a retry keeps the failed one's workspace",
    () => {
      const f = workspaceFixture();
      f.hooks.workerChanges = unchanged;
      const counter = countInspections(f);
      return withService(f.layer, function* (service) {
        const failed = yield* service.start(
          repoWriter({ profile: "reviewer", routeContinuation: reviewerContinuation(0) }),
        );
        const control = f.children.controls.at(-1)!;
        control.exit(1);
        yield* yieldUntil(() => control.released() === 1);
        const stopped = yield* stoppedWriter(service);
        yield* settleTurns;
        expect(counter.inspected).toBe(0);
        expect(yield* outcomeOf(service, failed.id)).toBeUndefined();
        expect(yield* outcomeOf(service, stopped.id)).toBeUndefined();
        expect(f.statuses()).toEqual(["active", "active"]);
        const claim = yield* service.claimRetryContinuation(failed.id);
        const retried = yield* service.startRetrySessionOwned({
          ...repoWriter({ profile: "reviewer", routeContinuation: reviewerContinuation(1) }),
          supersedes: { runId: failed.id, claimToken: claim.claimToken },
        });
        expect(retried.workspaceId).not.toBe(failed.workspaceId);
        expect(f.entries.size).toBe(3);
      });
    },
  );

  it.effect("keeps an unchanged workspace a read-only descendant still uses", () => {
    const f = workspaceFixture();
    f.hooks.workerChanges = unchanged;
    const counter = countInspections(f);
    return withService(f.layer, function* (service) {
      const writer = yield* service.start(repoWriter());
      const reader = yield* service.startSessionOwnedFrom(writer.id, request({ cwd: "/repo" }));
      expect(reader.cwd).toBe(writer.cwd);
      yield* completeLocalRun(service, f.children.controls[0]!, writer.id, "Done.");
      yield* settleTurns;
      expect(counter.inspected).toBe(0);
      expect(yield* outcomeOf(service, writer.id)).toBeUndefined();
      expect(f.entries.get(writer.workspaceId!)?.status).toBe("active");
    });
  });

  it.effect("keeps the workspace when inspection fails", () => {
    const f = workspaceFixture();
    f.hooks.workerChanges = new WorkspaceError({ operation: "inspect", message: "Unreadable." });
    const counter = countInspections(f);
    return withService(f.layer, function* (service) {
      const writer = yield* completedWriter(service, f);
      yield* yieldUntil(() => counter.inspected === 1);
      yield* settleTurns;
      expect(yield* outcomeOf(service, writer.id)).toBeUndefined();
      expect(f.entries.get(writer.workspaceId!)?.status).toBe("active");
      expect((yield* service.workspaceReview(writer.workspaceId!)).revisionId).toBeDefined();
    });
  });

  it.effect("delivers and awaits the report without waiting for the probe", () => {
    const delivered: SubagentNotification[] = [];
    const f = workspaceFixture({
      serviceOptions: {
        notify: (notification) => {
          delivered.push(notification);
          return acknowledgeCompletions(notification);
        },
      },
    });
    f.hooks.workerChanges = unchanged;
    return withService(f.layer, function* (service) {
      const gate = yield* pauseAt;
      f.hooks.before.inspectWorkerChanges = gate.pause;
      const writer = yield* completedWriter(service, f);
      yield* Deferred.await(gate.entered);
      yield* service.deliverPendingCompletions;
      expect(delivered).toMatchObject([{ type: "completed", runs: [{ id: writer.id }] }]);
      expect(yield* awaitRuns(service, [writer.id])).toMatchObject([{ state: "completed" }]);
      expect(f.entries.get(writer.workspaceId!)?.status).toBe("active");
      yield* Deferred.succeed(gate.release, undefined);
      expect(yield* settledOutcome(service, writer.id)).toEqual({ status: "auto-discarded" });
    });
  });

  it.effect("names the outcome in a completion delivered after it is known", () => {
    const delivered: SubagentNotification[] = [];
    const f = workspaceFixture({
      serviceOptions: {
        notify: (notification) => {
          delivered.push(notification);
          return acknowledgeCompletions(notification);
        },
      },
    });
    f.hooks.workerChanges = unchanged;
    return withService(f.layer, function* (service) {
      const writer = yield* completedWriter(service, f);
      yield* settledOutcome(service, writer.id);
      yield* service.deliverPendingCompletions;
      expect(delivered).toMatchObject([
        {
          type: "completed",
          runs: [{ id: writer.id, workspaceOutcome: { status: "auto-discarded" } }],
        },
      ]);
    });
  });
});
