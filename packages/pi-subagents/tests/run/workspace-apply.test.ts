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

const verified = () =>
  workspaceFixture({ serviceOptions: { workspaceVerify: { command: ["pnpm", "test"] } } });

const completedWriter = (service: SubagentServiceContract, f: Fixture) =>
  Effect.gen(function* () {
    const run = yield* service.start(repoWriter());
    yield* completeLocalRun(service, f.children.controls.at(-1)!, run.id, "Done.");
    return run;
  });

const listed = (service: SubagentServiceContract, workspaceId: string) =>
  service
    .workspaceList()
    .pipe(
      Effect.map((listing) =>
        listing.records.find((entry) => entry.handle.workspaceId === workspaceId),
      ),
    );

describe("one-step workspace apply", () => {
  it.effect("integrates an unreviewed revision and reports it as unverified", () => {
    const f = workspaceFixture();
    return withService(f.layer, function* (service) {
      const id = (yield* stoppedWriter(service)).workspaceId!;
      const applied = yield* service.workspaceApply(id);
      expect(applied).toMatchObject({
        integrated: true,
        reviewed: false,
        changedPaths: ["file.ts"],
        changedPathCount: 1,
        verification: { status: "not-configured" },
        untouchedDriftPaths: [],
        remainingBackupPaths: [],
        leaseReleaseUnconfirmed: false,
      });
      expect(f.integrations).toMatchObject([
        { workspaceId: id, revisionId: applied.revisionId, preparationId: applied.preparationId },
      ]);
      expect(f.verifications).toEqual([]);
      expect(f.entries.get(id)?.status).toBe("integrated");
      expect(yield* service.workspaceApply(id).pipe(Effect.flip)).toMatchObject({
        code: "workspace_finished",
      });
    });
  });

  it.effect("verifies the exact prepared tree before integrating a reviewed revision", () => {
    const f = verified();
    return withService(f.layer, function* (service) {
      const id = (yield* stoppedWriter(service)).workspaceId!;
      const page = yield* service.workspaceReview(id);
      yield* service.workspaceReview(id, { revisionId: page.revisionId, offset: page.nextOffset! });
      const applied = yield* service.workspaceApply(id, { revisionId: page.revisionId });
      expect(applied).toMatchObject({
        integrated: true,
        reviewed: true,
        revisionId: page.revisionId,
        verification: { status: "passed", command: ["pnpm", "test"], outputTail: "verified" },
      });
      expect(f.verifications).toMatchObject([{ preparationId: applied.preparationId }]);
      expect(f.entries.get(id)?.status).toBe("integrated");
    });
  });

  it.effect(
    "a failed verification integrates nothing and only a fresh careful preparation can",
    () => {
      const f = verified();
      return withService(f.layer, function* (service) {
        const id = (yield* stoppedWriter(service)).workspaceId!;
        f.hooks.verifyFailure = new WorkspaceError({
          operation: "verify",
          message: "Workspace verification failed.",
          detail: "1 failing test",
        });
        const failed = yield* service.workspaceApply(id);
        expect(failed).toMatchObject({
          integrated: false,
          verification: {
            status: "failed",
            command: ["pnpm", "test"],
            outputTail: "1 failing test",
          },
        });
        expect(failed.preparedCwd).toBe(f.entries.get(id)?.preparation?.cwd);
        expect(f.integrations).toEqual([]);
        expect(yield* listed(service, id)).toMatchObject({
          status: "prepared",
          preparation: { preparationId: failed.preparationId },
        });
        expect(
          yield* service
            .workspaceApply(id, {
              revisionId: failed.revisionId,
              preparationId: failed.preparationId,
            })
            .pipe(Effect.flip),
        ).toMatchObject({ code: "workspace_verification_failed" });
        const careful = yield* reviewAndPrepare(service, id);
        expect(careful.revisionId).toBe(failed.revisionId);
        expect(careful.preparationId).not.toBe(failed.preparationId);
        yield* service.workspaceApply(id, {
          revisionId: careful.revisionId,
          preparationId: careful.preparationId,
        });
        expect(f.integrations).toMatchObject([{ preparationId: careful.preparationId }]);
      });
    },
  );

  it.effect("interrupting verification leaves the workspace free, unpublished, and usable", () => {
    const f = verified();
    return withService(f.layer, function* (service) {
      const id = (yield* stoppedWriter(service)).workspaceId!;
      const gate = yield* pauseAt;
      f.hooks.before.verify = gate.pause;
      const applying = yield* service.workspaceApply(id).pipe(Effect.forkChild);
      yield* Deferred.await(gate.entered);
      yield* Fiber.interrupt(applying);
      expect(f.integrations).toEqual([]);
      expect(yield* listed(service, id)).toMatchObject({ status: "frozen" });
      f.hooks.before.verify = undefined;
      expect(yield* service.workspaceApply(id)).toMatchObject({ integrated: true });
    });
  });

  it.effect("unconfirmed verification cleanup quarantines the workspace", () => {
    const f = verified();
    return withService(f.layer, function* (service) {
      const writer = yield* completedWriter(service, f);
      const id = writer.workspaceId!;
      f.hooks.verifyFailure = new WorkspaceError({
        operation: "verify",
        message: "Verification cleanup is unconfirmed.",
        cleanupUnconfirmed: true,
      });
      expect(yield* service.workspaceApply(id).pipe(Effect.flip)).toMatchObject({
        code: "workspace_verify_cleanup_unconfirmed",
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
    const f = verified();
    return withService(f.layer, function* (service) {
      const writer = yield* completedWriter(service, f);
      const id = writer.workspaceId!;
      const gate = yield* pauseAt;
      f.hooks.before.verify = gate.pause;
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
      expect(yield* Fiber.join(applying)).toMatchObject({ integrated: true });
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

  it.effect("integrates exactly a prepared pair without preparing or verifying again", () => {
    const f = verified();
    return withService(f.layer, function* (service) {
      const id = (yield* stoppedWriter(service)).workspaceId!;
      const stale = yield* reviewAndPrepare(service, id);
      const tested = yield* service.workspacePrepare(id, stale.revisionId);
      expect(
        yield* service
          .workspaceApply(id, { revisionId: stale.revisionId, preparationId: stale.preparationId })
          .pipe(Effect.flip),
      ).toMatchObject({ code: "workspace_preparation_stale" });
      const applied = yield* service.workspaceApply(id, {
        revisionId: tested.revisionId,
        preparationId: tested.preparationId,
      });
      expect(applied).toMatchObject({
        integrated: true,
        reviewed: true,
        revisionId: tested.revisionId,
        preparationId: tested.preparationId,
        preparedCwd: tested.cwd,
        changedPaths: ["file.ts"],
        changedPathCount: 1,
        verification: { status: "parent-tested" },
      });
      expect(f.verifications).toEqual([]);
      expect(f.integrations).toMatchObject([{ preparationId: tested.preparationId }]);
    });
  });

  it.effect("runs setup in an applied preparation only when verification tests it", () => {
    const workspaceSetup = { command: ["pnpm", "install"] };
    const unverified = workspaceFixture({ workspaceSetup });
    const checked = workspaceFixture({
      workspaceSetup,
      serviceOptions: { workspaceVerify: { command: ["pnpm", "test"] } },
    });
    return Effect.gen(function* () {
      yield* withService(unverified.layer, function* (service) {
        const id = (yield* stoppedWriter(service)).workspaceId!;
        yield* service.workspaceApply(id);
        expect(unverified.setups).toEqual(["worker"]);
        // Manual prepare still provisions the tree the parent tests in.
        const careful = (yield* stoppedWriter(service)).workspaceId!;
        const { preparationId } = yield* reviewAndPrepare(service, careful);
        expect(unverified.setups).toEqual(["worker", "worker", preparationId]);
      });
      yield* withService(checked.layer, function* (service) {
        const id = (yield* stoppedWriter(service)).workspaceId!;
        const applied = yield* service.workspaceApply(id);
        expect(checked.setups).toEqual(["worker", applied.preparationId]);
      });
    });
  });

  it.effect("the careful path still requires every page before preparing", () => {
    const f = verified();
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
