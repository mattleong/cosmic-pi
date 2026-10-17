import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { yieldUntil } from "pi-cosmic-core/testing";
import { WriterLeaseReleaseError } from "../../src/boundary/writer-lease.ts";
import { emptyUsage, type SubagentRunView } from "../../src/run/model.ts";
import type { SubagentServiceContract } from "../../src/run/service.ts";
import { WorkspaceError } from "../../src/workspace/model.ts";
import {
  completeLocalRun,
  profileLayerFor,
  request,
  reviewerContinuation,
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
    const run = yield* service.start(
      repoWriter({ profile: "reviewer", routeContinuation: reviewerContinuation(0) }),
    );
    const control = f.children.controls.at(-1)!;
    control.exit(1);
    yield* yieldUntil(() => control.released() === 1);
    return run;
  });

const retryWith = (service: SubagentServiceContract, failed: SubagentRunView, claimToken: string) =>
  service.startRetrySessionOwned({
    ...repoWriter({ profile: "reviewer", routeContinuation: reviewerContinuation(1) }),
    supersedes: { runId: failed.id, claimToken },
  });

const retry = (service: SubagentServiceContract, failed: SubagentRunView) =>
  service
    .claimRetryContinuation(failed.id)
    .pipe(Effect.flatMap((claim) => retryWith(service, failed, claim.claimToken)));

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
  it.effect("route retry forks a new workspace from the failed writer's workspace", () => {
    const f = workspaceFixture();
    return withService(f.layer, function* (service) {
      const failed = yield* failedWriter(service, f);
      const successor = yield* retry(service, failed);
      expect(successor.workspaceId).toBeDefined();
      expect(successor.workspaceId).not.toBe(failed.workspaceId);
      expect(f.entries.size).toBe(2);
    });
  });

  it.effect("route retry refuses to fork from an integrated workspace", () => {
    const f = workspaceFixture();
    return withService(f.layer, function* (service) {
      const failed = yield* failedWriter(service, f);
      const id = failed.workspaceId!;
      const tested = yield* reviewAndPrepare(service, id);
      yield* service.workspaceIntegrate(id, tested.revisionId, tested.preparationId);
      expect(yield* retry(service, failed).pipe(Effect.flip)).toMatchObject({
        code: "workspace_finished",
      });
      expect(f.entries.size).toBe(1);
    });
  });

  it.effect("route retry refuses to fork a workspace a revision successor now owns", () => {
    const f = workspaceFixture();
    return withService(f.layer, function* (service) {
      const failed = yield* failedWriter(service, f);
      yield* service.workspaceRevise(failed.workspaceId!, "Finish the change.");
      expect(yield* retry(service, failed).pipe(Effect.flip)).toMatchObject({
        code: "workspace_owner_unavailable",
      });
      expect(f.entries.size).toBe(1);
    });
  });

  it.effect("a stale retry claim fails before any workspace is forked", () => {
    const f = workspaceFixture();
    return withService(f.layer, function* (service) {
      const failed = yield* failedWriter(service, f);
      expect(yield* retryWith(service, failed, "stale-claim").pipe(Effect.flip)).toMatchObject({
        code: "retry_claim_stale",
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
        yield* service
          .workspaceIntegrate(id, tested.revisionId, tested.preparationId)
          .pipe(Effect.flip),
      ).toMatchObject({ code: "workspace_preparation_stale" });
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
            ? Effect.fail(new WriterLeaseReleaseError({ message: "Release unconfirmed." }))
            : base.release(lease),
      })),
    });
    return withService(f.layer, function* (service) {
      const integrated = yield* completedWriter(service, f);
      const kept = yield* completedWriter(service, f);
      const tested = yield* reviewAndPrepare(service, integrated.workspaceId!);
      yield* service.workspaceIntegrate(
        integrated.workspaceId!,
        tested.revisionId,
        tested.preparationId,
      );
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
      const successor = yield* service.workspaceRevise(id, "Also update the docs.");
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
        yield* service
          .workspaceIntegrate(id, tested.revisionId, tested.preparationId)
          .pipe(Effect.flip),
      ).toMatchObject({ code: "workspace_preparation_stale" });
      const revised = yield* reviewAndPrepare(service, id);
      expect(revised.revisionId).not.toBe(tested.revisionId);
      yield* service.workspaceIntegrate(id, revised.revisionId, revised.preparationId);
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
      yield* service.workspaceIntegrate(id, tested.revisionId, tested.preparationId);
    });
  });

  it.effect("a preparation whose setup failed cannot be integrated", () => {
    const f = workspaceFixture({ workspaceSetup: { command: ["setup"] } });
    return withService(f.layer, function* (service) {
      const id = (yield* stoppedWriter(service)).workspaceId!;
      const first = yield* service.workspaceReview(id);
      yield* service.workspaceReview(id, {
        revisionId: first.revisionId,
        offset: first.nextOffset!,
      });
      f.hooks.setupFailure = new WorkspaceError({ operation: "setup", message: "Setup failed." });
      expect(yield* service.workspacePrepare(id, first.revisionId).pipe(Effect.flip)).toMatchObject(
        { code: "workspace_setup_failed" },
      );
      const untested = f.entries.get(id)?.preparation?.preparationId;
      expect(untested).toBeDefined();
      const shown = yield* listed(service, id);
      expect(shown?.status).toBe("frozen");
      expect(shown?.preparation).toBeUndefined();
      expect(
        yield* service.workspaceIntegrate(id, first.revisionId, untested!).pipe(Effect.flip),
      ).toMatchObject({ code: "workspace_preparation_stale" });
      f.hooks.setupFailure = undefined;
      const prepared = yield* service.workspacePrepare(id, first.revisionId);
      yield* service.workspaceIntegrate(id, first.revisionId, prepared.preparationId);
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
