import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type { SubagentServiceContract } from "../../src/run/service.ts";
import { WorkspaceError } from "../../src/workspace/model.ts";
import {
  completeLocalRun,
  runViews,
  waitForCompleted,
  withService,
} from "./fixtures/service-harness.ts";
import {
  pauseAt,
  repoWriter,
  reviewAndPrepare,
  stoppedWriter,
  workspaceFixture,
} from "./fixtures/workspace-engine.ts";

type Fixture = ReturnType<typeof workspaceFixture>;

const hooked = () => workspaceFixture({ worktreeCreate: [{ command: ["pnpm", "install"] }] });

const completedWriter = (service: SubagentServiceContract, f: Fixture) =>
  Effect.gen(function* () {
    const run = yield* service.start(repoWriter());
    yield* completeLocalRun(service, f.children.controls.at(-1)!, run.id, "Done.");
    return run;
  });

describe("one-step workspace apply", () => {
  it.effect("integrates an unreviewed revision and reports it as untested", () => {
    const f = workspaceFixture();
    return withService(f.layer, function* (service) {
      const id = (yield* stoppedWriter(service)).workspaceId!;
      const applied = yield* service.workspaceApply(id);
      expect(applied).toMatchObject({
        reviewed: false,
        changedPaths: ["file.ts"],
        changedPathCount: 1,
        testing: "untested",
        untouchedDriftPaths: [],
        remainingBackupPaths: [],
        leaseReleaseUnconfirmed: false,
      });
      expect(f.integrations).toMatchObject([
        { workspaceId: id, revisionId: applied.revisionId, preparationId: applied.preparationId },
      ]);
      expect(f.entries.get(id)?.status).toBe("integrated");
      expect(yield* service.workspaceApply(id).pipe(Effect.flip)).toMatchObject({
        code: "workspace_finished",
      });
    });
  });

  it.effect("reports a pinned, fully read revision as reviewed", () => {
    const f = workspaceFixture();
    return withService(f.layer, function* (service) {
      const id = (yield* stoppedWriter(service)).workspaceId!;
      const page = yield* service.workspaceReview(id);
      yield* service.workspaceReview(id, { revisionId: page.revisionId, offset: page.nextOffset! });
      const applied = yield* service.workspaceApply(id, { revisionId: page.revisionId });
      expect(applied).toMatchObject({
        reviewed: true,
        revisionId: page.revisionId,
        testing: "untested",
      });
      expect(f.entries.get(id)?.status).toBe("integrated");
    });
  });

  it.effect("runs WorktreeCreate in a tree prepared for testing, not in a plain apply's", () => {
    const f = hooked();
    return withService(f.layer, function* (service) {
      const writer = yield* stoppedWriter(service);
      yield* service.workspaceApply(writer.workspaceId!);
      expect(f.hookRuns).toEqual([{ tree: "worker", runId: undefined }]);
      const careful = yield* stoppedWriter(service);
      const { preparationId } = yield* reviewAndPrepare(service, careful.workspaceId!);
      expect(f.hookRuns.slice(1)).toEqual([
        { tree: "worker", runId: undefined },
        { tree: preparationId, runId: careful.id },
      ]);
    });
  });

  it.effect("a plain apply integrates the parent's tested preparation", () => {
    const f = hooked();
    return withService(f.layer, function* (service) {
      const id = (yield* stoppedWriter(service)).workspaceId!;
      const tested = yield* reviewAndPrepare(service, id);
      const hookRuns = f.hookRuns.length;
      expect(yield* service.workspaceApply(id)).toMatchObject({
        revisionId: tested.revisionId,
        preparationId: tested.preparationId,
        reviewed: true,
        testing: "parent-tested",
      });
      expect(f.hookRuns).toHaveLength(hookRuns);
      expect(f.integrations).toMatchObject([{ preparationId: tested.preparationId }]);
    });
  });

  it.effect("pages a review by offset alone", () => {
    const f = workspaceFixture();
    return withService(f.layer, function* (service) {
      const id = (yield* stoppedWriter(service)).workspaceId!;
      const first = yield* service.workspaceReview(id, { limit: 1 });
      let next = first.nextOffset;
      while (next !== undefined) {
        const page = yield* service.workspaceReview(id, { offset: next });
        expect(page.revisionId).toBe(first.revisionId);
        next = page.nextOffset;
      }
      expect(yield* service.workspacePrepare(id, first.revisionId)).toMatchObject({
        revisionId: first.revisionId,
      });
    });
  });

  it.effect("a failed WorktreeCreate hook in the prepared tree leaves it untested", () => {
    const f = hooked();
    return withService(f.layer, function* (service) {
      const id = (yield* stoppedWriter(service)).workspaceId!;
      f.hooks.createHookFailure = new WorkspaceError({
        operation: "hook",
        message: "Hook failed.",
      });
      expect(yield* reviewAndPrepare(service, id).pipe(Effect.flip)).toMatchObject({
        code: "workspace_hook_failed",
      });
      expect(f.integrations).toEqual([]);
      expect(yield* service.workspaceApply(id)).toMatchObject({ testing: "untested" });
      expect(f.entries.get(id)?.status).toBe("integrated");
    });
  });

  it.effect("interrupting a preparation's hooks leaves the workspace free and usable", () => {
    const f = hooked();
    return withService(f.layer, function* (service) {
      const id = (yield* stoppedWriter(service)).workspaceId!;
      const gate = yield* pauseAt;
      f.hooks.before.createHooks = gate.pause;
      const preparing = yield* reviewAndPrepare(service, id).pipe(Effect.forkChild);
      yield* Deferred.await(gate.entered);
      yield* Fiber.interrupt(preparing);
      expect(f.integrations).toEqual([]);
      f.hooks.before.createHooks = undefined;
      expect(yield* service.workspaceApply(id)).toMatchObject({ testing: "untested" });
    });
  });

  it.effect("unconfirmed hook cleanup quarantines the workspace", () => {
    const f = hooked();
    return withService(f.layer, function* (service) {
      const writer = yield* completedWriter(service, f);
      const id = writer.workspaceId!;
      f.hooks.createHookFailure = new WorkspaceError({
        operation: "hook",
        message: "Hook cleanup is unconfirmed.",
        cleanupUnconfirmed: true,
      });
      expect(yield* reviewAndPrepare(service, id).pipe(Effect.flip)).toMatchObject({
        code: "workspace_hook_cleanup_unconfirmed",
      });
      expect(yield* service.workspaceApply(id).pipe(Effect.flip)).toMatchObject({
        code: "workspace_process_unsettled",
      });
      expect(yield* service.resume(writer.id).pipe(Effect.flip)).toMatchObject({
        code: "workspace_process_unsettled",
      });
      expect(f.integrations).toEqual([]);
    });
  });

  it.effect("keeps the workspace busy for resume and revision until apply finishes", () => {
    const f = workspaceFixture();
    return withService(f.layer, function* (service) {
      const writer = yield* completedWriter(service, f);
      const id = writer.workspaceId!;
      const gate = yield* pauseAt;
      f.hooks.before.prepare = gate.pause;
      const applying = yield* service.workspaceApply(id).pipe(Effect.forkChild);
      yield* Deferred.await(gate.entered);
      expect(yield* service.resume(writer.id).pipe(Effect.flip)).toMatchObject({
        code: "workspace_operation_in_progress",
      });
      const revising = yield* service
        .workspaceRevise(id, "Also cover docs.")
        .pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.succeed(gate.release, undefined);
      expect(yield* Fiber.join(applying)).toMatchObject({ testing: "untested" });
      expect(yield* Fiber.join(revising)).toMatchObject({ code: "workspace_finished" });
      expect(f.children.controls).toHaveLength(1);
    });
  });

  it.effect("waits for a finished writer's process cleanup instead of refusing", () => {
    const f = workspaceFixture();
    return withService(f.layer, function* (service) {
      const writer = yield* service.start(repoWriter());
      const control = f.children.controls.at(-1)!;
      const cleanup = yield* Deferred.make<void>();
      control.gateRelease(cleanup);
      control.settle("Done.");
      yield* waitForCompleted(service, writer.id);
      const applying = yield* service.workspaceApply(writer.workspaceId!).pipe(Effect.forkChild);
      for (let turn = 0; turn < 20; turn += 1) yield* Effect.yieldNow;
      expect(f.integrations).toEqual([]);
      yield* Deferred.succeed(cleanup, undefined);
      expect(yield* Fiber.join(applying)).toMatchObject({ testing: "untested" });
    });
  });

  it.effect("refuses while the writer runs or for anyone but the direct parent", () => {
    const f = workspaceFixture();
    return withService(f.layer, function* (service) {
      const active = yield* service.start(repoWriter());
      expect(yield* service.workspaceApply(active.workspaceId!).pipe(Effect.flip)).toMatchObject({
        code: "workspace_process_unsettled",
      });
      const id = (yield* stoppedWriter(service)).workspaceId!;
      expect(yield* service.workspaceApply(id, {}, active.id).pipe(Effect.flip)).toMatchObject({
        code: "workspace_owner_unavailable",
      });
      expect(f.integrations).toEqual([]);
    });
  });

  it.effect("refuses a revision that a resume made stale", () => {
    const f = workspaceFixture();
    return withService(f.layer, function* (service) {
      const writer = yield* completedWriter(service, f);
      const id = writer.workspaceId!;
      const old = yield* service.workspaceReview(id);
      yield* service.resume(writer.id, "Rename the helper too.");
      yield* completeLocalRun(service, f.children.controls[1]!, writer.id, "Renamed.");
      expect(
        yield* service.workspaceApply(id, { revisionId: old.revisionId }).pipe(Effect.flip),
      ).toMatchObject({ code: "workspace_revision_stale" });
      const applied = yield* service.workspaceApply(id);
      expect(applied.revisionId).not.toBe(old.revisionId);
    });
  });

  it.effect("integrates exactly a prepared pair without preparing again", () => {
    const f = hooked();
    return withService(f.layer, function* (service) {
      const id = (yield* stoppedWriter(service)).workspaceId!;
      const stale = yield* reviewAndPrepare(service, id);
      const tested = yield* service.workspacePrepare(id, stale.revisionId);
      expect(
        yield* service
          .workspaceApply(id, { revisionId: stale.revisionId, preparationId: stale.preparationId })
          .pipe(Effect.flip),
      ).toMatchObject({ code: "workspace_preparation_stale" });
      const hookRuns = f.hookRuns.length;
      const applied = yield* service.workspaceApply(id, {
        revisionId: tested.revisionId,
        preparationId: tested.preparationId,
      });
      expect(applied).toMatchObject({
        reviewed: true,
        revisionId: tested.revisionId,
        preparationId: tested.preparationId,
        preparedCwd: tested.cwd,
        changedPaths: ["file.ts"],
        changedPathCount: 1,
        testing: "parent-tested",
      });
      expect(f.hookRuns).toHaveLength(hookRuns);
      expect(f.integrations).toMatchObject([{ preparationId: tested.preparationId }]);
    });
  });

  it.effect("the careful path still requires every page before preparing", () => {
    const f = hooked();
    return withService(f.layer, function* (service) {
      const id = (yield* stoppedWriter(service)).workspaceId!;
      const page = yield* service.workspaceReview(id);
      expect(yield* service.workspacePrepare(id, page.revisionId).pipe(Effect.flip)).toMatchObject({
        code: "workspace_review_incomplete",
      });
      expect(f.entries.get(id)?.preparation).toBeUndefined();
    });
  });
});

const outcomeOf = (service: SubagentServiceContract, id: string) =>
  runViews(service).pipe(Effect.map((runs) => runs.find((run) => run.id === id)?.workspaceOutcome));
const settledOutcome = (service: SubagentServiceContract, id: string) =>
  Effect.gen(function* () {
    for (let turn = 0; turn < 200; turn++) {
      const outcome = yield* outcomeOf(service, id);
      if (outcome) return outcome;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(new Error(`Workspace outcome of ${id} never settled.`));
  });

describe("a worktree writer's workspace outcome", () => {
  it.effect("stops offering a proposal once it is applied or discarded", () => {
    const f = workspaceFixture();
    return withService(f.layer, function* (service) {
      const applied = yield* completedWriter(service, f);
      expect(yield* settledOutcome(service, applied.id)).toMatchObject({ status: "proposal" });
      yield* service.workspaceApply(applied.workspaceId!);
      expect(yield* outcomeOf(service, applied.id)).toEqual({ status: "integrated" });

      const discarded = yield* completedWriter(service, f);
      expect(yield* settledOutcome(service, discarded.id)).toMatchObject({ status: "proposal" });
      yield* service.workspaceDiscard(discarded.workspaceId!);
      expect(yield* outcomeOf(service, discarded.id)).toEqual({ status: "discarded" });
    });
  });

  it.effect("narrows the proposal to the changes a partial apply left", () => {
    const f = workspaceFixture();
    const changed = ["a.ts", "b.ts", "c.ts"];
    f.hooks.changedPaths = changed;
    f.hooks.workerChanges = {
      changedPaths: changed,
      uncapturedPaths: [],
      diffStat: changed.map((path, index) => ({
        path,
        change: "modified" as const,
        binary: false,
        addedLines: index + 1,
        deletedLines: 1,
      })),
    };
    return withService(f.layer, function* (service) {
      const writer = yield* completedWriter(service, f);
      expect(yield* settledOutcome(service, writer.id)).toMatchObject({
        status: "proposal",
        changedFileCount: 3,
      });
      yield* service.workspaceApply(writer.workspaceId!, { paths: ["a.ts", "c.ts"] });
      expect(yield* outcomeOf(service, writer.id)).toEqual({
        status: "proposal",
        changedFileCount: 1,
        diffStat: {
          addedLines: 2,
          deletedLines: 1,
          files: [{ path: "b.ts", addedLines: 2, deletedLines: 1 }],
        },
      });
    });
  });
});
