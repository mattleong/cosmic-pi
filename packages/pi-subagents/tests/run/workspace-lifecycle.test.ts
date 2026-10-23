import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { yieldUntil } from "pi-cosmic-core/testing";
import { WriterLeaseReleaseError } from "../../src/boundary/writer-lease.ts";
import { emptyUsage } from "../../src/run/model.ts";
import type { SubagentServiceContract } from "../../src/run/service.ts";
import { WorkspaceError } from "../../src/workspace/model.ts";
import {
  completeLocalRun,
  profileLayerFor,
  request,
  runView,
  withService,
} from "./fixtures/service-harness.ts";
import {
  gateCreate,
  leasesWith,
  repoWriter,
  reviewAndPrepare,
  stoppedWriter,
  workspaceFixture,
} from "./fixtures/workspace-engine.ts";

type Fixture = ReturnType<typeof workspaceFixture>;

const nesting = (limits: {
  readonly maxDirectChildren?: number;
  readonly maxActiveRuns?: number;
}) => ({
  nestingPolicy: { maxDirectChildren: 12, maxDepth: 3, ...limits },
});

const failedWriter = (service: SubagentServiceContract, f: Fixture) =>
  Effect.gen(function* () {
    const run = yield* service.start(repoWriter());
    const control = f.children.controls.at(-1)!;
    control.exit(1);
    yield* yieldUntil(() => control.released() === 1);
    return run;
  });

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

describe("writer workspace lifecycle", () => {
  it.effect("keeps a failed writer's workspace an ordinary proposal for its parent", () => {
    const f = workspaceFixture();
    return withService(f.layer, function* (service) {
      const failed = yield* failedWriter(service, f);
      const tested = yield* reviewAndPrepare(service, failed.workspaceId!);
      yield* service.workspaceApply(failed.workspaceId!, { revisionId: tested.revisionId });
      expect(f.entries.get(failed.workspaceId!)?.status).toBe("integrated");
    });
  });

  it.effect("counts unresolved workspaces without probing other sessions' owner leases", () => {
    const f = workspaceFixture();
    return withService(f.layer, function* (service) {
      yield* service.start(repoWriter());
      f.hooks.ownerProbeFailure = WorkspaceError.make({
        operation: "lock",
        message: "Owner leases are unreadable.",
      });
      expect(yield* service.inspectWriterWorkspace).toEqual({
        mode: "worktree",
        unresolvedWorkspaceCount: 1,
      });
    });
  });

  it.effect("a mode switch leaves existing writers and their revisions in worktrees", () => {
    const f = workspaceFixture();
    return withService(f.layer, function* (service) {
      const active = yield* service.start(repoWriter());
      const completed = yield* completedWriter(service, f);
      yield* service.setWriterWorkspaceMode("shared-checkout", Effect.void);
      expect(yield* service.inspectWriterWorkspace).toEqual({
        mode: "shared-checkout",
        unresolvedWorkspaceCount: 2,
      });
      expect(yield* runView(service, active.id)).toMatchObject({
        writerWorkspaceMode: "worktree",
        workspaceId: active.workspaceId,
      });
      const { run: revised } = yield* service.workspaceRevise(
        completed.workspaceId!,
        "Cover the edge.",
      );
      expect(revised).toMatchObject({
        cwd: completed.cwd,
        workspaceId: completed.workspaceId,
        writerWorkspaceMode: "worktree",
      });
      expect(f.entries.size).toBe(2);
      expect(yield* service.start(repoWriter())).toMatchObject({
        cwd: "/repo",
        writerWorkspaceMode: "shared-checkout",
      });
    });
  });

  it.effect("a failed writer resumes in its own workspace and reopens its review", () => {
    const f = workspaceFixture();
    return withService(f.layer, function* (service) {
      const failed = yield* failedWriter(service, f);
      const id = failed.workspaceId!;
      const reviewed = yield* service.workspaceReview(id);
      const resumed = yield* service.resume(failed.id, "Finish the change.");
      expect(resumed).toMatchObject({ state: "running", workspaceId: id, cwd: failed.cwd });
      expect(f.children.controls.at(-1)!.launch.cwd).toBe(failed.cwd);
      expect(f.entries.size).toBe(1);
      expect(yield* listed(service, id)).toMatchObject({ status: "active" });
      expect(yield* service.workspaceReview(id).pipe(Effect.flip)).toMatchObject({
        code: "workspace_process_unsettled",
      });
      yield* completeLocalRun(service, f.children.controls.at(-1)!, failed.id, "Finished.");
      expect(
        yield* service.workspaceReview(id, { revisionId: reviewed.revisionId }).pipe(Effect.flip),
      ).toMatchObject({ code: "workspace_revision_stale" });
      expect((yield* service.workspaceReview(id)).revisionId).not.toBe(reviewed.revisionId);
    });
  });

  it.effect("a stopped writer resumes in its own workspace", () => {
    const f = workspaceFixture();
    return withService(f.layer, function* (service) {
      const stopped = yield* stoppedWriter(service);
      yield* yieldUntil(() => f.children.controls[0]!.released() === 1);
      const resumed = yield* service.resume(stopped.id, "Continue where you stopped.");
      expect(resumed).toMatchObject({
        state: "running",
        workspaceId: stopped.workspaceId,
        cwd: stopped.cwd,
      });
      expect(f.entries.size).toBe(1);
    });
  });

  it.effect("resume reports a workspace owned by a running revision successor", () => {
    const f = workspaceFixture();
    return withService(f.layer, function* (service) {
      const writer = yield* completedWriter(service, f);
      yield* service.workspaceRevise(writer.workspaceId!, "Also cover the edge case.");
      expect(yield* service.resume(writer.id).pipe(Effect.flip)).toMatchObject({
        code: "workspace_owner_unavailable",
      });
    });
  });

  it.effect("resume makes the reviewed revision and tested preparation stale", () => {
    const f = workspaceFixture();
    return withService(f.layer, function* (service) {
      const writer = yield* completedWriter(service, f);
      const id = writer.workspaceId!;
      const tested = yield* reviewAndPrepare(service, id);
      yield* service.resume(writer.id, "Rename the helper too.");
      yield* completeLocalRun(service, f.children.controls[1]!, writer.id, "Renamed.");
      expect(yield* listed(service, id)).toMatchObject({ status: "active" });
      expect(
        yield* service.workspaceApply(id, { revisionId: tested.revisionId }).pipe(Effect.flip),
      ).toMatchObject({ code: "workspace_revision_stale" });
      expect(
        yield* service.workspaceReview(id, { revisionId: tested.revisionId }).pipe(Effect.flip),
      ).toMatchObject({ code: "workspace_revision_stale" });
      expect((yield* service.workspaceReview(id)).revisionId).not.toBe(tested.revisionId);
    });
  });

  it.effect("refuses worktree writer resume while integration is quarantined", () => {
    const f = workspaceFixture({
      writerLeases: leasesWith((base) => ({
        release: (lease) =>
          lease.canonicalCwd === "/repo"
            ? Effect.fail(WriterLeaseReleaseError.make({ message: "Release unconfirmed." }))
            : base.release(lease),
      })),
    });
    return withService(f.layer, function* (service) {
      const integrated = yield* completedWriter(service, f);
      const kept = yield* completedWriter(service, f);
      const tested = yield* reviewAndPrepare(service, integrated.workspaceId!);
      yield* service.workspaceApply(integrated.workspaceId!, { revisionId: tested.revisionId });
      expect(yield* service.resume(kept.id).pipe(Effect.flip)).toMatchObject({
        code: "workspace_integration_quarantined",
      });
      expect(f.children.controls).toHaveLength(2);
    });
  });

  it.effect("revision makes the old review and preparation stale until the next review", () => {
    const f = workspaceFixture();
    return withService(f.layer, function* (service) {
      const writer = yield* completedWriter(service, f);
      const id = writer.workspaceId!;
      const tested = yield* reviewAndPrepare(service, id);
      const { run: successor } = yield* service.workspaceRevise(id, "Also update the docs.");
      expect(successor.workspaceId).toBe(id);
      yield* completeLocalRun(service, f.children.controls[1]!, successor.id, "Updated.");
      const current = yield* listed(service, id);
      expect(current).toMatchObject({ status: "active" });
      expect(current?.revision).toBeUndefined();
      expect(current?.preparation).toBeUndefined();
      expect(
        yield* service.workspaceReview(id, { revisionId: tested.revisionId }).pipe(Effect.flip),
      ).toMatchObject({ code: "workspace_revision_stale" });
      expect(
        yield* service.workspaceApply(id, { revisionId: tested.revisionId }).pipe(Effect.flip),
      ).toMatchObject({ code: "workspace_revision_stale" });
      const revised = yield* reviewAndPrepare(service, id);
      expect(revised.revisionId).not.toBe(tested.revisionId);
      yield* service.workspaceApply(id, { revisionId: revised.revisionId });
      expect(f.entries.get(id)?.status).toBe("integrated");
    });
  });

  it.effect("a refused revision successor keeps the review and tested preparation", () => {
    let replaced = false;
    const f = workspaceFixture({
      writerLeases: leasesWith((base) => ({
        canonicalize: (cwd) =>
          base
            .canonicalize(cwd)
            .pipe(
              Effect.map((identity) =>
                replaced && cwd.startsWith("/private/")
                  ? { ...identity, filesystemIdentity: "dev:2;ino:3", digest: "f".repeat(64) }
                  : identity,
              ),
            ),
      })),
    });
    return withService(f.layer, function* (service) {
      const writer = yield* completedWriter(service, f);
      const id = writer.workspaceId!;
      const tested = yield* reviewAndPrepare(service, id);
      replaced = true;
      expect(
        yield* service.workspaceRevise(id, "Also update the docs.").pipe(Effect.flip),
      ).toMatchObject({ code: "writer_cwd_identity_changed" });
      replaced = false;
      expect(yield* listed(service, id)).toMatchObject({
        status: "prepared",
        preparation: { preparationId: tested.preparationId },
      });
      yield* service.workspaceApply(id, { revisionId: tested.revisionId });
      expect(f.entries.get(id)?.status).toBe("integrated");
    });
  });

  it.effect("review without a revision returns the frozen revision instead of refreezing", () => {
    const f = workspaceFixture();
    return withService(f.layer, function* (service) {
      const id = (yield* stoppedWriter(service)).workspaceId!;
      const first = yield* service.workspaceReview(id);
      expect((yield* service.workspaceReview(id)).revisionId).toBe(first.revisionId);
      const tested = yield* reviewAndPrepare(service, id);
      expect(tested.revisionId).toBe(first.revisionId);
      const again = yield* service.workspaceReview(id);
      expect(again).toMatchObject({ revisionId: first.revisionId, offset: 0 });
      yield* service.workspaceApply(id, { revisionId: tested.revisionId });
    });
  });

  it.effect("a preparation whose WorktreeCreate hooks failed cannot be integrated", () => {
    const f = workspaceFixture({ worktreeCreate: [{ command: ["setup"] }] });
    return withService(f.layer, function* (service) {
      const id = (yield* stoppedWriter(service)).workspaceId!;
      const first = yield* service.workspaceReview(id);
      f.hooks.createHookFailure = WorkspaceError.make({
        operation: "hook",
        message: "Hook failed.",
      });
      expect(yield* service.workspacePrepare(id, first.revisionId).pipe(Effect.flip)).toMatchObject(
        { code: "workspace_hook_failed" },
      );
      const untested = f.entries.get(id)?.preparation?.preparationId;
      expect(untested).toBeDefined();
      const shown = yield* listed(service, id);
      expect(shown?.status).toBe("frozen");
      expect(shown?.preparation).toBeUndefined();
      // Apply prepares the revision again rather than integrate the untested tree.
      const applied = yield* service.workspaceApply(id, { revisionId: first.revisionId });
      expect(applied).toMatchObject({ testing: "untested" });
      expect(applied.preparationId).not.toBe(untested);
      expect(f.entries.get(id)?.status).toBe("integrated");
    });
  });

  it.effect("checks tree capacity and spend limit before creating a workspace", () =>
    Effect.gen(function* () {
      const full = workspaceFixture();
      yield* withService(full.layer, function* (service) {
        yield* service.start(request({ cwd: "/repo", ...nesting({ maxActiveRuns: 1 }) }));
        expect(
          yield* service.start(repoWriter(nesting({ maxActiveRuns: 1 }))).pipe(Effect.flip),
        ).toMatchObject({ code: "tree_capacity" });
        expect(full.entries.size).toBe(0);
      });
      const spent = workspaceFixture({
        profiles: profileLayerFor({ version: 6, sessionSpendLimit: 1 }),
        serviceOptions: { restoredSessionUsage: { ...emptyUsage(), cost: 2 } },
      });
      yield* withService(spent.layer, function* (service) {
        expect(yield* service.start(repoWriter()).pipe(Effect.flip)).toMatchObject({
          code: "session_spend_limit",
        });
        expect(spent.entries.size).toBe(0);
      });
    }),
  );

  it.effect("a nested start cannot take the tree slot a creating worktree launch holds", () => {
    const f = workspaceFixture();
    const limits = nesting({ maxActiveRuns: 2 });
    return withService(f.layer, function* (service) {
      const reader = yield* service.start(request({ cwd: "/repo", ...limits }));
      const create = yield* gateCreate(f);
      const launching = yield* service.start(repoWriter(limits)).pipe(Effect.forkChild);
      yield* Deferred.await(create.entered);
      expect(
        yield* service.startSessionOwnedFrom(reader.id, request(limits)).pipe(Effect.flip),
      ).toMatchObject({ code: "tree_capacity" });
      yield* Deferred.succeed(create.release, undefined);
      expect((yield* Fiber.join(launching)).workspaceId).toBeDefined();
    });
  });

  it.effect(
    "waits for a creating launch's slot but fails at once when running children fill it",
    () => {
      const f = workspaceFixture();
      const limits = nesting({ maxDirectChildren: 1 });
      return withService(f.layer, function* (service) {
        const create = yield* gateCreate(f);
        const first = yield* service.start(repoWriter(limits)).pipe(Effect.forkChild);
        yield* Deferred.await(create.entered);
        const second = yield* service.start(repoWriter(limits)).pipe(Effect.forkChild);
        for (let turn = 0; turn < 20; turn++) yield* Effect.yieldNow;
        expect(second.pollUnsafe()).toBeUndefined();
        expect(f.entries.size).toBe(1);
        f.hooks.afterCreate = Effect.void;
        yield* Fiber.interrupt(first);
        const admitted = yield* Fiber.join(second);
        expect(f.statuses()).toEqual(["discarded", "active"]);
        expect(yield* service.start(repoWriter(limits)).pipe(Effect.flip)).toMatchObject({
          code: "direct_child_capacity",
        });
        expect(f.entries.size).toBe(2);
        yield* service.stop(admitted.id);
      });
    },
  );
});
