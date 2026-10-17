import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { yieldUntil } from "pi-cosmic-core/testing";
import { WriterLeaseConflictError } from "../../src/boundary/writer-lease.ts";
import type { SubagentError } from "../../src/run/errors.ts";
import { SubagentService, type SubagentServiceContract } from "../../src/run/service.ts";
import type { WorkspaceRecord } from "../../src/workspace/model.ts";
import {
  completeLocalRun,
  fakeNativeReportBackendLayer,
  nativeReportRequest,
  profileLayerFor,
  request,
  reviewerContinuation,
  withService,
} from "./fixtures/service-harness.ts";
import {
  leasesWith,
  pauseAt,
  repoWriter,
  workspaceFixture as fixture,
} from "./fixtures/workspace-engine.ts";

type Fixture = ReturnType<typeof fixture>;

/** A running worktree writer and the worktree writer it started from its own worker tree. */
const nestedPair = (service: SubagentServiceContract, overrides = {}) =>
  Effect.gen(function* () {
    const parent = yield* service.start(repoWriter());
    const child = yield* service.startSessionOwnedFrom(parent.id, repoWriter(overrides));
    return {
      parent,
      child,
      parentWorkspace: parent.workspaceId!,
      childWorkspace: child.workspaceId!,
    };
  });

/** Writer leases that, like the real ones, refuse a directory another lease already holds. */
const exclusiveLeases = () => {
  const held = new Set<string>();
  const acquired: string[] = [];
  const writerLeases = leasesWith((base) => ({
    acquire: (input) =>
      held.has(input.cwd.digest)
        ? Effect.fail(
            new WriterLeaseConflictError({ reason: "live", message: "Fixture lease is held." }),
          )
        : base.acquire(input).pipe(
            Effect.tap((lease) =>
              Effect.sync(() => {
                held.add(lease.filesystemIdentityDigest);
                acquired.push(lease.canonicalCwd);
              }),
            ),
          ),
    release: (lease) =>
      base
        .release(lease)
        .pipe(Effect.tap(() => Effect.sync(() => held.delete(lease.filesystemIdentityDigest)))),
  }));
  return { writerLeases, acquired };
};

const nestedRecord = (
  workspaceId: string,
  ownerId: string,
  source: {
    readonly sourceRoot: string;
    readonly sourceWorkspaceId?: string;
    readonly checkoutRoot?: string;
  },
  status: WorkspaceRecord["status"] = "active",
): WorkspaceRecord => ({
  version: 1,
  handle: {
    workspaceId,
    ownerId,
    sourceCwd: source.sourceRoot,
    cwd: `/private/${workspaceId}/worker`,
    writerCwd: {
      path: `/private/${workspaceId}/worker`,
      filesystemIdentity: `dev:1;ino:/private/${workspaceId}/worker`,
      digest: "2".padStart(64, "0"),
    },
    ...source,
  },
  status,
  baseline: "baseline",
});

const outcomeOf = (service: SubagentServiceContract, id: string) =>
  Effect.gen(function* () {
    for (let turn = 0; turn < 200; turn++) {
      const run = (yield* service.list).find((entry) => entry.id === id);
      if (run?.workspaceOutcome) return run.workspaceOutcome;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(new Error(`Workspace outcome of ${id} never settled.`));
  });

const expectRefused = <A>(effect: Effect.Effect<A, SubagentError>, code: string) =>
  effect.pipe(
    Effect.match({
      onFailure: (error) => expect(error).toMatchObject({ code }),
      onSuccess: () => expect.fail(`Expected a ${code} refusal.`),
    }),
  );

const listedIds = (listing: { readonly records: ReadonlyArray<WorkspaceRecord> }) =>
  listing.records.map((entry) => entry.handle.workspaceId).toSorted();

/** Every operation that would read or publish the parent's proposal while a child is unresolved. */
const parentOperations = (
  service: SubagentServiceContract,
  workspaceId: string,
): ReadonlyArray<Effect.Effect<unknown, SubagentError>> => [
  service.workspaceReview(workspaceId),
  service.workspacePrepare(workspaceId, "revision-1"),
  service.workspaceIntegrate(workspaceId, "revision-1", "prepared-1"),
  service.workspaceApply(workspaceId),
  service.workspaceRevise(workspaceId, "Try again."),
];

const expectChildrenUnresolved = (service: SubagentServiceContract, workspaceId: string) =>
  Effect.forEach(parentOperations(service, workspaceId), (operation) =>
    expectRefused(operation, "workspace_children_unresolved"),
  );

const startedWorkspaces = (f: Fixture) => f.entries.size;

describe("nested worktree writers", () => {
  it.effect("a worktree writer owns the worktree writer it starts from its own worker tree", () => {
    const f = fixture();
    return withService(f.layer, function* (service) {
      const { parent, child, parentWorkspace, childWorkspace } = yield* nestedPair(service);
      expect(child).toMatchObject({ writerWorkspaceMode: "worktree", parentRunId: parent.id });
      expect(child.cwd).toBe(`/private/${childWorkspace}/worker`);
      expect(f.entries.get(childWorkspace)?.handle).toMatchObject({
        ownerId: `session-1/${parent.id}`,
        sourceCwd: parent.cwd,
        sourceRoot: parent.cwd,
        sourceWorkspaceId: parentWorkspace,
        checkoutRoot: "/repo",
      });
      // Only the direct parent may act on the child's proposal.
      yield* service.stop(child.id);
      yield* expectRefused(service.workspaceReview(childWorkspace), "workspace_owner_unavailable");
      const page = yield* service.workspaceReview(childWorkspace, {}, parent.id);
      expect(page.revisionId).toBeDefined();
      expect(
        (yield* service.workspaceList(parent.id)).records.map((entry) => entry.handle.workspaceId),
      ).toEqual([childWorkspace]);
    });
  });

  it.effect("readers and shared-checkout writers cannot start worktree writers", () => {
    const f = fixture();
    return withService(f.layer, function* (service) {
      const reader = yield* service.start(request({ cwd: "/repo" }));
      const shared = yield* service.start(
        repoWriter({ writerWorkspaceModeOverride: "shared-checkout" }),
      );
      for (const caller of [reader, shared])
        for (const isolation of [undefined, "worktree" as const])
          yield* expectRefused(
            service.startSessionOwnedFrom(
              caller.id,
              repoWriter({ writerWorkspaceModeOverride: isolation }),
            ),
            "workspace_nested_writer_unsupported",
          );
      expect(startedWorkspaces(f)).toBe(0);
    });
  });

  it.effect("a Claude worktree writer cannot start worktree writers", () => {
    const f = fixture();
    const backend = fakeNativeReportBackendLayer();
    const layer = SubagentService.layer(f.options).pipe(
      Layer.provide(Layer.mergeAll(backend.layer, f.leaseLayer, f.engineLayer)),
      Layer.provideMerge(profileLayerFor({})),
    );
    return withService(layer, function* (service) {
      const parent = yield* service.start(
        nativeReportRequest({ cwd: "/repo", writeIntent: "writer" }),
      );
      expect(parent).toMatchObject({ writerWorkspaceMode: "worktree", runtime: "claude" });
      yield* expectRefused(
        service.startSessionOwnedFrom(parent.id, repoWriter()),
        "workspace_nested_writer_unsupported",
      );
      expect(startedWorkspaces(f)).toBe(1);
    });
  });

  it.effect("a worktree writer's writers default to worktrees and may still share its tree", () => {
    const f = fixture();
    return withService(f.layer, function* (service) {
      const parent = yield* service.start(repoWriter({ writes: ["a.ts"] }));
      // The session default applies only to writers started without a worktree-writer parent.
      yield* service.setWriterWorkspaceMode("shared-checkout", Effect.void);
      const isolated = yield* service.startSessionOwnedFrom(parent.id, repoWriter());
      expect(isolated.writerWorkspaceMode).toBe("worktree");
      expect(f.entries.get(isolated.workspaceId!)?.handle.sourceWorkspaceId).toBe(
        parent.workspaceId,
      );
      const shared = yield* service.startSessionOwnedFrom(
        parent.id,
        repoWriter({ writerWorkspaceModeOverride: "shared-checkout", writes: ["b.ts"] }),
      );
      expect(shared).toMatchObject({ writerWorkspaceMode: "shared-checkout", cwd: parent.cwd });
      expect(shared.workspaceId).toBeUndefined();
      expect(startedWorkspaces(f)).toBe(2);
    });
  });

  it.effect(
    "the root waits for a shared-checkout writer still editing a finished parent's tree",
    () => {
      const f = fixture();
      return withService(f.layer, function* (service) {
        const parent = yield* service.start(repoWriter({ writes: ["a.ts"] }));
        const shared = yield* service.startSessionOwnedFrom(
          parent.id,
          repoWriter({ writerWorkspaceModeOverride: "shared-checkout", writes: ["b.ts"] }),
        );
        // Natural completion leaves the shared writer running in the parent's worker tree.
        yield* completeLocalRun(service, f.children.controls[0]!, parent.id, "Done.");
        yield* expectRefused(
          service.workspaceApply(parent.workspaceId!),
          "workspace_process_unsettled",
        );
        yield* expectRefused(
          service.workspaceReview(parent.workspaceId!),
          "workspace_process_unsettled",
        );
        expect(f.integrations).toEqual([]);
        yield* service.stop(shared.id);
        expect(yield* service.workspaceApply(parent.workspaceId!)).toMatchObject({
          integrated: true,
        });
      });
    },
  );

  it.effect("a running parent applies its child into its own worker tree", () => {
    const leases = exclusiveLeases();
    const f = fixture({ writerLeases: leases.writerLeases });
    return withService(f.layer, function* (service) {
      const { parent, child, parentWorkspace, childWorkspace } = yield* nestedPair(service);
      yield* service.stop(child.id);
      const applied = yield* service.workspaceApply(childWorkspace, {}, parent.id);
      expect(applied).toMatchObject({ integrated: true });
      expect(f.integrations.map((target) => target.workspaceId)).toEqual([childWorkspace]);
      // The parent's own lease covers its worker tree; other directories are leased as usual.
      expect(leases.acquired.filter((cwd) => cwd === parent.cwd)).toHaveLength(1);
      expect(leases.acquired).toContain(`${parent.cwd}/packages/b`);
      expect((yield* service.status(parent.id)).state).toBe("running");
      // With its child resolved, the parent's own workspace proceeds once it stops.
      yield* service.stop(parent.id);
      expect((yield* service.workspaceReview(parentWorkspace)).revisionId).toBeDefined();
    });
  });

  it.effect("the parent revises its child in place and retries fork from its tree", () => {
    const f = fixture();
    return withService(f.layer, function* (service) {
      const parent = yield* service.start(repoWriter());
      const failed = yield* service.startSessionOwnedFrom(
        parent.id,
        repoWriter({ profile: "reviewer", routeContinuation: reviewerContinuation(0) }),
      );
      const control = f.children.controls.at(-1)!;
      control.exit(1);
      yield* yieldUntil(() => control.released() === 1);
      const claim = yield* service.claimRetryContinuation(failed.id);
      const forked = yield* service.startRetrySessionOwned({
        ...repoWriter({ profile: "reviewer", routeContinuation: reviewerContinuation(1) }),
        cwd: parent.cwd,
        parentRunId: parent.id,
        supersedes: { runId: failed.id, claimToken: claim.claimToken },
      });
      expect(forked.workspaceId).not.toBe(failed.workspaceId);
      expect(f.entries.get(forked.workspaceId!)?.handle).toMatchObject({
        ownerId: `session-1/${parent.id}`,
        sourceWorkspaceId: parent.workspaceId,
      });
      yield* service.stop(forked.id);
      const successor = yield* service.workspaceRevise(
        forked.workspaceId!,
        "Also cover the edge case.",
        parent.id,
      );
      expect(successor).toMatchObject({
        workspaceId: forked.workspaceId,
        parentRunId: parent.id,
        writerWorkspaceMode: "worktree",
      });
    });
  });

  it.effect("the root cannot use a parent's proposal while its child is unresolved", () => {
    const f = fixture();
    return withService(f.layer, function* (service) {
      const { parent, parentWorkspace, childWorkspace } = yield* nestedPair(service);
      yield* service.stop(parent.id);
      yield* expectChildrenUnresolved(service, parentWorkspace);
      yield* expectRefused(
        service.workspaceDiscard(parentWorkspace),
        "workspace_children_unresolved",
      );
      // The stopped parent can't resolve its child, so the root discards it, then the parent.
      const childOperations: ReadonlyArray<Effect.Effect<unknown, SubagentError>> = [
        service.workspaceReview(childWorkspace),
        service.workspaceApply(childWorkspace),
        service.workspaceIntegrate(childWorkspace, "revision-1", "prepared-1"),
        service.workspaceRevise(childWorkspace, "Continue."),
      ];
      for (const operation of childOperations)
        yield* expectRefused(operation, "workspace_owner_unavailable");
      yield* service.workspaceDiscard(childWorkspace);
      expect(f.entries.get(childWorkspace)?.status).toBe("discarded");
      yield* service.workspaceDiscard(parentWorkspace);
      expect(f.entries.get(parentWorkspace)?.status).toBe("discarded");
    });
  });

  it.effect("the root cannot discard a child while its parent still runs", () => {
    const f = fixture();
    return withService(f.layer, function* (service) {
      const { child, childWorkspace } = yield* nestedPair(service);
      yield* service.stop(child.id);
      yield* expectRefused(service.workspaceDiscard(childWorkspace), "workspace_owner_unavailable");
      expect(f.entries.get(childWorkspace)?.status).toBe("active");
    });
  });

  it.effect("an ancestor of a stopped parent may discard its child, but no other run may", () => {
    const f = fixture();
    return withService(f.layer, function* (service) {
      const grandparent = yield* service.start(repoWriter());
      const sibling = yield* service.start(repoWriter());
      const parent = yield* service.startSessionOwnedFrom(grandparent.id, repoWriter());
      const child = yield* service.startSessionOwnedFrom(parent.id, repoWriter());
      const childWorkspace = child.workspaceId!;
      expect(f.entries.get(childWorkspace)?.handle.checkoutRoot).toBe("/repo");
      yield* service.stop(parent.id);
      yield* expectRefused(
        service.workspaceDiscard(childWorkspace, sibling.id),
        "workspace_owner_unavailable",
      );
      yield* expectRefused(
        service.workspaceReview(childWorkspace, {}, grandparent.id),
        "workspace_owner_unavailable",
      );
      yield* service.workspaceDiscard(childWorkspace, grandparent.id);
      expect(f.entries.get(childWorkspace)?.status).toBe("discarded");
      // The grandparent owns the parent's workspace directly and may now use it.
      expect(
        (yield* service.workspaceReview(parent.workspaceId!, {}, grandparent.id)).revisionId,
      ).toBeDefined();
    });
  });

  it.effect(
    "a child still being created blocks its parent, then fails admission once the parent stops",
    () => {
      const f = fixture();
      return withService(f.layer, function* (service) {
        const parent = yield* service.start(repoWriter());
        const parentWorkspace = parent.workspaceId!;
        const gate = yield* pauseAt;
        f.hooks.before.create = gate.pause;
        const launching = yield* service
          .startSessionOwnedFrom(parent.id, repoWriter())
          .pipe(Effect.forkChild);
        yield* Deferred.await(gate.entered);
        yield* service.stop(parent.id);
        yield* expectChildrenUnresolved(service, parentWorkspace);
        f.hooks.before.create = undefined;
        yield* Deferred.succeed(gate.release, undefined);
        const failure = yield* Fiber.join(launching).pipe(Effect.flip);
        expect(failure).toMatchObject({ code: "parent_run_disconnected" });
        expect(f.statuses()).toEqual(["active", "discarded"]);
        expect((yield* service.workspaceReview(parentWorkspace)).revisionId).toBeDefined();
      });
    },
  );

  it.effect("keeps a completed parent's unchanged workspace while its child is unresolved", () => {
    const f = fixture();
    return withService(f.layer, function* (service) {
      const { parent, child, parentWorkspace, childWorkspace } = yield* nestedPair(service);
      yield* service.stop(child.id);
      f.hooks.workerChanges = { changedPaths: [], uncapturedPaths: [] };
      yield* completeLocalRun(service, f.children.controls[0]!, parent.id, "Done.");
      expect(yield* outcomeOf(service, parent.id)).toEqual({
        status: "proposal",
        changedFileCount: 0,
      });
      expect(f.entries.get(parentWorkspace)?.status).toBe("active");
      // The completed parent can no longer resolve its child, so the root may discard it.
      yield* service.workspaceDiscard(childWorkspace);
      expect(f.entries.get(childWorkspace)?.status).toBe("discarded");
    });
  });

  it.effect("the root lists nested workspaces under their real checkout", () => {
    const f = fixture();
    f.entries.set("foreign", nestedRecord("foreign", "old-session/root", { sourceRoot: "/repo" }));
    f.entries.set(
      "foreign-child",
      nestedRecord("foreign-child", "old-session/run-1", {
        sourceRoot: "/private/foreign/worker",
        sourceWorkspaceId: "foreign",
        checkoutRoot: "/repo",
      }),
    );
    f.entries.set(
      "elsewhere-child",
      nestedRecord("elsewhere-child", "old-session/run-2", {
        sourceRoot: "/private/elsewhere/worker",
        sourceWorkspaceId: "elsewhere",
        checkoutRoot: "/elsewhere",
      }),
    );
    f.hooks.orphanOwnerEnded = true;
    return withService(f.layer, function* (service) {
      const { parent, childWorkspace } = yield* nestedPair(service);
      expect(listedIds(yield* service.workspaceList())).toEqual(
        ["foreign", "foreign-child", parent.workspaceId!, childWorkspace].toSorted(),
      );
      expect(listedIds(yield* service.workspaceList(parent.id))).toEqual([childWorkspace]);
      // Orphans are discarded children first.
      yield* expectRefused(service.workspaceDiscard("foreign"), "workspace_children_unresolved");
      yield* service.workspaceDiscard("foreign-child");
      yield* service.workspaceDiscard("foreign");
      expect(f.entries.get("foreign")?.status).toBe("discarded");
    });
  });
});
