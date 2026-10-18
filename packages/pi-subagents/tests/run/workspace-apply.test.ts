import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type { SubagentServiceContract } from "../../src/run/service.ts";
import { WorkspaceError } from "../../src/workspace/model.ts";
import { completeLocalRun, withService } from "./fixtures/service-harness.ts";
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

  it.effect("runs WorktreeCreate in every prepared tree, a plain apply's included", () => {
    const f = hooked();
    return withService(f.layer, function* (service) {
      const writer = yield* stoppedWriter(service);
      const applied = yield* service.workspaceApply(writer.workspaceId!);
      expect(f.hookRuns).toEqual([
        { tree: "worker", runId: undefined },
        { tree: applied.preparationId, runId: writer.id },
      ]);
      const careful = yield* stoppedWriter(service);
      const { preparationId } = yield* reviewAndPrepare(service, careful.workspaceId!);
      expect(f.hookRuns.slice(2)).toEqual([
        { tree: "worker", runId: undefined },
        { tree: preparationId, runId: careful.id },
      ]);
    });
  });

  it.effect("a failed WorktreeCreate hook in the prepared tree integrates nothing", () => {
    const f = hooked();
    return withService(f.layer, function* (service) {
      const id = (yield* stoppedWriter(service)).workspaceId!;
      f.hooks.createHookFailure = new WorkspaceError({
        operation: "hook",
        message: "Hook failed.",
      });
      expect(yield* service.workspaceApply(id).pipe(Effect.flip)).toMatchObject({
        code: "workspace_hook_failed",
      });
      expect(f.integrations).toEqual([]);
      f.hooks.createHookFailure = undefined;
      expect(yield* service.workspaceApply(id)).toMatchObject({ testing: "untested" });
      expect(f.entries.get(id)?.status).toBe("integrated");
    });
  });

  it.effect("interrupting hooks leaves the workspace free, unpublished, and usable", () => {
    const f = hooked();
    return withService(f.layer, function* (service) {
      const id = (yield* stoppedWriter(service)).workspaceId!;
      const gate = yield* pauseAt;
      f.hooks.before.createHooks = gate.pause;
      const applying = yield* service.workspaceApply(id).pipe(Effect.forkChild);
      yield* Deferred.await(gate.entered);
      yield* Fiber.interrupt(applying);
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
      expect(yield* service.workspaceApply(id).pipe(Effect.flip)).toMatchObject({
        code: "workspace_hook_cleanup_unconfirmed",
      });
      expect(yield* service.workspaceReview(id).pipe(Effect.flip)).toMatchObject({
        code: "workspace_process_unsettled",
      });
      expect(yield* service.resume(writer.id).pipe(Effect.flip)).toMatchObject({
        code: "workspace_process_unsettled",
      });
      expect(f.integrations).toEqual([]);
    });
  });

  it.effect("keeps the workspace busy for resume and revision until apply finishes", () => {
    const f = hooked();
    return withService(f.layer, function* (service) {
      const writer = yield* completedWriter(service, f);
      const id = writer.workspaceId!;
      const gate = yield* pauseAt;
      f.hooks.before.createHooks = gate.pause;
      const applying = yield* service.workspaceApply(id).pipe(Effect.forkChild);
      yield* Deferred.await(gate.entered);
      expect(yield* service.resume(writer.id).pipe(Effect.flip)).toMatchObject({
        code: "workspace_operation_in_progress",
      });
      expect(
        yield* service.workspaceRevise(id, "Also cover docs.").pipe(Effect.flip),
      ).toMatchObject({ code: "workspace_operation_in_progress" });
      expect(yield* service.workspaceDiscard(id).pipe(Effect.flip)).toMatchObject({
        code: "workspace_operation_in_progress",
      });
      yield* Deferred.succeed(gate.release, undefined);
      expect(yield* Fiber.join(applying)).toMatchObject({ testing: "untested" });
      expect(f.children.controls).toHaveLength(1);
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
