import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import { yieldUntil } from "pi-cosmic-core/testing";
import { nodeFsPromises as fs, nodePath as path } from "../../src/boundary/node-builtins.ts";
import * as os from "node:os";
import {
  WriterCwdCanonicalizationError,
  WriterLeaseReleaseError,
  WriterLeaseService,
} from "../../src/boundary/writer-lease.ts";
import {
  WorkspaceError,
  type UnavailableWorkspaceArtifact,
  type WorkspaceIntegrationTarget,
  type WorkspaceRecord,
  type WorkspaceTarget,
} from "../../src/workspace/model.ts";
import { WorkspaceService, type WorkspaceServiceContract } from "../../src/workspace/service.ts";
import { compileResultContract } from "../../src/domain/result-contract.ts";
import type { SubagentServiceContract } from "../../src/run/service.ts";
import { SubagentProfileService } from "../../src/profiles/service.ts";
import {
  completeLocalRun,
  fakeChildLayer,
  fakeWriterLeaseLayer,
  profileLayerFor,
  request,
  serviceLayer,
  withService,
} from "./fixtures/service-harness.ts";

const record = (
  workspaceId: string,
  ownerId: string,
  sourceRoot: string,
  status: WorkspaceRecord["status"],
): WorkspaceRecord => ({
  version: 1,
  handle: {
    workspaceId,
    ownerId,
    sourceRoot,
    sourceCwd: sourceRoot,
    cwd: `/private/${workspaceId}`,
  },
  status,
  baseline: "baseline",
});

/** Expects a writer-mode switch to be refused as busy before its persist effect runs. */
const expectModeSwitchBlocked = (service: SubagentServiceContract) =>
  Effect.gen(function* () {
    let persisted = false;
    const persist = Effect.sync(() => {
      persisted = true;
    });
    expect(
      yield* service.setWriterWorkspaceMode("shared-checkout", persist).pipe(Effect.flip),
    ).toMatchObject({ code: "workspace_mode_busy" });
    expect(persisted).toBe(false);
  });

/** Reads every diff page of a stopped writer's proposal, then prepares that exact revision. */
const reviewAndPrepare = (service: SubagentServiceContract, workspaceId: string) =>
  Effect.gen(function* () {
    const first = yield* service.workspaceReview(workspaceId);
    yield* service.workspaceReview(workspaceId, {
      revisionId: first.revisionId,
      offset: first.nextOffset!,
    });
    const prepared = yield* service.workspacePrepare(workspaceId, first.revisionId);
    return { revisionId: first.revisionId, preparationId: prepared.preparationId };
  });

const policy = { maxDirectChildren: 1, maxDepth: 3 };

/** Engine operations a test can pause before their state change. */
type GatedOperation = "freeze" | "prepare" | "discard";

/** Injection points inside the fixture engine: after a create, and before other operations. */
interface EngineHooks {
  afterCreate: Effect.Effect<void>;
  before: { [Operation in GatedOperation]?: Effect.Effect<void> | undefined };
  failDiscard: boolean;
}

/** Pauses at a gate until released; `entered` completes once the operation reaches it. */
const pauseAt = Effect.gen(function* () {
  const entered = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const pause = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)));
  return { entered, release, pause };
});

function fixture(
  sourceCwd = "/repo",
  canonicalize = (cwd: string) => cwd,
  writerLeases?: Layer.Layer<WriterLeaseService>,
  profiles?: ReturnType<typeof profileLayerFor>,
  children = fakeChildLayer(),
) {
  const hooks: EngineHooks = { afterCreate: Effect.void, before: {}, failDiscard: false };
  const gated = <A, E>(operation: GatedOperation, effect: Effect.Effect<A, E>) =>
    Effect.suspend(() => hooks.before[operation] ?? Effect.void).pipe(Effect.andThen(effect));
  const integrations: WorkspaceIntegrationTarget[] = [];
  const entries = new Map<string, WorkspaceRecord>();
  const unavailable: UnavailableWorkspaceArtifact[] = [];
  const requireEntry = (target: WorkspaceTarget) =>
    Effect.gen(function* () {
      const entry = entries.get(target.workspaceId);
      if (!entry || entry.handle.ownerId !== target.ownerId)
        return yield* new WorkspaceError({ operation: "inspect", message: "Unknown owner" });
      return entry;
    });
  let ordinal = 0;
  let revisions = 0;
  const create: WorkspaceServiceContract["create"] = (input) =>
    Effect.sync(() => {
      const workspaceId = `workspace-${++ordinal}`;
      const handle = {
        workspaceId,
        ownerId: input.ownerId,
        sourceCwd: input.sourceCwd,
        sourceRoot: input.sourceCwd,
        cwd: `/private/${workspaceId}`,
      };
      entries.set(workspaceId, { version: 1, handle, status: "active", baseline: "original-base" });
      input.onAcquired?.(handle);
      return handle;
    }).pipe(Effect.tap(() => hooks.afterCreate));
  const engine: WorkspaceServiceContract = {
    create,
    inspect: requireEntry,
    list: ({ ownerId }) =>
      Effect.sync(() => [...entries.values()].filter((entry) => entry.handle.ownerId === ownerId)),
    listAll: () => Effect.sync(() => ({ records: [...entries.values()], unavailable })),
    freeze: (target) =>
      gated("freeze", requireEntry(target)).pipe(
        Effect.map((entry) => {
          const revision = entry.revision ?? {
            revisionId: `revision-${++revisions}`,
            diff: "a".repeat(20_000),
            changedPaths: ["file.ts"],
          };
          entries.set(target.workspaceId, { ...entry, status: "frozen", revision });
          return revision;
        }),
      ),
    prepare: (target) =>
      gated("prepare", requireEntry(target)).pipe(
        Effect.map((entry) => {
          const preparation = {
            preparationId: "prepared-1",
            revisionId: target.revisionId,
            cwd: "/private/combined",
            leaseDirectories: [entry.handle.sourceRoot, `${entry.handle.sourceRoot}/packages/b`],
          };
          entries.set(target.workspaceId, { ...entry, status: "prepared", preparation });
          return preparation;
        }),
      ),
    integrate: (target) =>
      requireEntry(target).pipe(
        Effect.map((entry) => {
          integrations.push(target);
          const integrated = { ...entry, status: "integrated" as const };
          entries.set(target.workspaceId, integrated);
          return {
            record: integrated,
            workerRoot: entry.handle.cwd,
            uncapturedPaths: [],
            treeRemovalFailed: false,
          };
        }),
      ),
    revise: (target) =>
      requireEntry(target).pipe(
        Effect.map((entry) => {
          const { revision: _revision, preparation: _preparation, ...rest } = entry;
          entries.set(target.workspaceId, { ...rest, status: "active" });
          return entry.handle;
        }),
      ),
    fork: (target) =>
      requireEntry(target).pipe(
        Effect.flatMap((entry) =>
          create({
            sourceCwd: entry.handle.sourceCwd,
            ownerId: entry.handle.ownerId,
            onAcquired: target.onAcquired,
          }),
        ),
      ),
    discard: (target) =>
      gated("discard", requireEntry(target)).pipe(
        Effect.flatMap((entry) =>
          hooks.failDiscard
            ? Effect.fail(new WorkspaceError({ operation: "discard", message: "Fixture failure" }))
            : Effect.sync(() => {
                entries.set(target.workspaceId, { ...entry, status: "discarded" });
              }),
        ),
      ),
    recoverDiscard: () => Effect.void,
  };
  const acquired: string[] = [];
  const released: string[] = [];
  const canonicalized: string[] = [];
  const layer = serviceLayer(
    {
      writerWorkspaceMode: "worktree",
      workspaceOwnerId: "session-1",
      workspaceSourceCwd: sourceCwd,
    },
    profiles,
    writerLeases ??
      fakeWriterLeaseLayer({
        canonicalize,
        onCanonicalize: (cwd) => canonicalized.push(cwd),
        onAcquire: (lease) => acquired.push(lease.canonicalCwd),
        onRelease: (lease) => released.push(lease.canonicalCwd),
      }),
  ).pipe(Layer.provide(children.layer), Layer.provide(Layer.succeed(WorkspaceService, engine)));
  const statuses = () => [...entries.values()].map((entry) => entry.status);
  return {
    entries,
    unavailable,
    engine,
    children,
    layer,
    acquired,
    released,
    canonicalized,
    hooks,
    integrations,
    statuses,
  };
}

describe("writer workspace orchestration", () => {
  it.live("releases a real source lease when cancellation lands at acquisition handoff", () =>
    Effect.gen(function* () {
      const temporary = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "workspace-handoff-"))),
        (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
      );
      const root = path.join(temporary, "source");
      const worker = path.join(temporary, "worker");
      yield* Effect.promise(() => fs.mkdir(path.join(root, "packages/b"), { recursive: true }));
      yield* Effect.promise(() => fs.mkdir(worker));
      const leases = yield* WriterLeaseService.pipe(
        Effect.provide(WriterLeaseService.layer({ agentDirectory: temporary })),
      );
      const cwd = yield* leases.canonicalize(root);
      const wrapped = Layer.succeed(WriterLeaseService, {
        ...leases,
        canonicalize: (directory) =>
          leases.canonicalize(directory.startsWith("/private/") ? worker : directory),
        acquire: (input) =>
          leases
            .acquire(input)
            .pipe(
              Effect.tap(() =>
                input.cwd.digest === cwd.digest
                  ? Effect.withFiber((fiber) => Effect.sync(() => fiber.interruptUnsafe()))
                  : Effect.void,
              ),
            ),
      });
      const f = fixture(root, (directory) => directory, wrapped);
      yield* withService(f.layer, function* (service) {
        const run = yield* service.start(request({ cwd: root, writeIntent: "writer" }));
        yield* service.stop(run.id);
        const id = run.workspaceId!;
        const review = yield* service.workspaceReview(id);
        yield* service.workspaceReview(id, {
          revisionId: review.revisionId,
          offset: review.nextOffset!,
        });
        const prepared = yield* service.workspacePrepare(id, review.revisionId);
        const integrating = yield* service
          .workspaceIntegrate(id, review.revisionId, prepared.preparationId)
          .pipe(Effect.forkChild);
        expect(Exit.isFailure(yield* Fiber.await(integrating))).toBe(true);
        expect(f.entries.get(id)?.status).toBe("prepared");
        // Re-acquiring proves the interrupted integration released the source lease.
        const replacement = yield* leases.acquire({ cwd, runId: "replacement" });
        yield* leases.release(replacement);
      });
    }).pipe(Effect.scoped),
  );
  it.effect("shows repository orphans through a cwd alias and blocks mode changes", () => {
    const f = fixture("/alias/package", (cwd) =>
      cwd === "/alias/package" ? "/repo/package" : cwd,
    );
    f.entries.set("orphan", record("orphan", "old-session/root", "/repo", "active"));
    f.entries.set("unrelated", record("unrelated", "old-session/root", "/repo-other", "active"));
    return withService(f.layer, function* (service) {
      const reader = yield* service.start(
        request({ cwd: "/alias/package", writeIntent: "read-only" }),
      );
      expect(reader.cwd).toBe("/alias/package");
      expect(f.canonicalized).toEqual([]);
      expect(f.acquired).toEqual([]);
      expect(f.entries.size).toBe(2);
      expect(
        (yield* service.workspaceList()).records.map((entry) => entry.handle.workspaceId),
      ).toEqual(["orphan"]);
      expect(yield* service.inspectWriterWorkspace).toMatchObject({ canSwitch: false });
      yield* expectModeSwitchBlocked(service);
      expect(yield* service.workspaceDiscard("orphan").pipe(Effect.flip)).toMatchObject({
        code: "workspace_owner_unavailable",
      });
      f.entries.set("orphan", { ...f.entries.get("orphan")!, status: "discarded" });
      expect(yield* service.inspectWriterWorkspace).toMatchObject({ canSwitch: true });
      expect(f.acquired).toEqual([]);
    });
  });

  it.effect(
    "keeps unknown artifacts root-only and blocks mode changes without granting ownership",
    () => {
      const f = fixture();
      const artifact = {
        workspaceId: "unknown",
        status: "unavailable",
        reason: "recovery-record-unavailable",
      } as const;
      f.unavailable.push(artifact);
      return withService(f.layer, function* (service) {
        const reader = yield* service.start(request({ cwd: "/repo", writeIntent: "read-only" }));
        expect(f.canonicalized).toEqual([]);
        for (const [workspaceId, ownerId, sourceRoot, status] of [
          ["settled", "session-1/root", "/repo", "discarded"],
          ["nested", `session-1/${reader.id}`, "/repo", "integrated"],
          ["unrelated", "old-session/root", "/elsewhere", "active"],
        ] as const) {
          f.entries.set(workspaceId, record(workspaceId, ownerId, sourceRoot, status));
        }
        const root = yield* service.workspaceList();
        expect(root.records.map((entry) => entry.handle.workspaceId)).toEqual([
          "settled",
          "nested",
        ]);
        expect(root.unavailable).toEqual([artifact]);
        const nested = yield* service.workspaceList(reader.id);
        expect(nested.records.map((entry) => entry.handle.workspaceId)).toEqual(["nested"]);
        expect(nested.unavailable).toEqual([]);
        expect(yield* service.inspectWriterWorkspace).toMatchObject({ canSwitch: false });
        yield* expectModeSwitchBlocked(service);
        for (const operation of [
          service.workspaceReview(artifact.workspaceId),
          service.workspacePrepare(artifact.workspaceId, "revision"),
          service.workspaceIntegrate(artifact.workspaceId, "revision", "preparation"),
          service.workspaceRevise(artifact.workspaceId, "repair"),
          service.workspaceDiscard(artifact.workspaceId),
        ]) {
          expect(yield* operation.pipe(Effect.flip)).toMatchObject({
            code: "workspace_owner_unavailable",
          });
        }
        expect(f.unavailable).toEqual([artifact]);
        f.unavailable.length = 0;
        expect(yield* service.inspectWriterWorkspace).toMatchObject({ canSwitch: true });
      });
    },
  );

  it.effect("can review and prepare an owned proposal beside unavailable artifacts", () => {
    const f = fixture();
    f.unavailable.push({
      workspaceId: "unknown",
      status: "unavailable",
      reason: "recovery-record-unavailable",
    });
    return withService(f.layer, function* (service) {
      const writer = yield* service.start(request({ cwd: "/repo", writeIntent: "writer" }));
      yield* service.stop(writer.id);
      const workspaceId = writer.workspaceId!;
      const first = yield* service.workspaceReview(workspaceId);
      yield* service.workspaceReview(workspaceId, {
        revisionId: first.revisionId,
        offset: first.nextOffset!,
      });
      const prepared = yield* service.workspacePrepare(workspaceId, first.revisionId);
      expect(prepared.revisionId).toBe(first.revisionId);
      expect((yield* service.workspaceList()).unavailable).toHaveLength(1);
    });
  });

  it.effect("refuses script-origin writers before workspace creation or reservations", () => {
    const f = fixture();
    return withService(f.layer, function* (service) {
      expect(
        yield* service
          .startScriptSessionOwned(request({ cwd: "/repo", writeIntent: "writer" }))
          .pipe(Effect.flip),
      ).toMatchObject({ code: "scripted_subtree_writer_not_supported" });
      const reader = yield* service.startScriptSessionOwned(request({ cwd: "/repo" }));
      expect(
        yield* service
          .startSessionOwnedFrom(reader.id, request({ writeIntent: "writer" }))
          .pipe(Effect.flip),
      ).toMatchObject({ code: "scripted_subtree_writer_not_supported" });
      expect(f.entries.size).toBe(0);
      expect(f.acquired).toEqual([]);
      expect(f.canonicalized).toEqual([]);
      expect(yield* service.inspectWriterWorkspace).toMatchObject({ canSwitch: true });
      expect(yield* service.list).toHaveLength(1);
    });
  });

  it.effect(
    "nested readers inspect their parent's effective cwd but nested writers fail before artifact creation",
    () => {
      const f = fixture();
      return withService(f.layer, function* (service) {
        const parent = yield* service.start(request({ cwd: "/repo", writeIntent: "writer" }));
        const child = yield* service.startSessionOwnedFrom(
          parent.id,
          request({ cwd: "/wrong-source", writeIntent: "read-only" }),
        );
        expect(child.cwd).toBe(parent.cwd);
        expect(child.workspaceId).toBeUndefined();
        expect(f.children.controls[1]?.launch.cwd).toBe(parent.cwd);
        const failure = yield* service
          .startSessionOwnedFrom(parent.id, request({ cwd: "/repo", writeIntent: "writer" }))
          .pipe(Effect.flip);
        expect(failure).toMatchObject({ code: "workspace_nested_writer_unsupported" });
        expect(f.entries.size).toBe(1);
      });
    },
  );

  it.effect("launches simultaneous claimless writers in distinct private cwd leases", () => {
    const f = fixture();
    return withService(f.layer, function* (service) {
      const runs = yield* Effect.all(
        [
          service.start(request({ cwd: "/repo", writeIntent: "writer" })),
          service.start(request({ cwd: "/repo", writeIntent: "writer" })),
        ],
        { concurrency: "unbounded" },
      );
      expect(new Set(runs.map((run) => run.cwd)).size).toBe(2);
      expect(
        runs.every((run) => run.sourceCwd === "/repo" && run.writerWorkspaceMode === "worktree"),
      ).toBe(true);
      expect(f.acquired.every((cwd) => cwd.startsWith("/private/"))).toBe(true);
      expect(f.children.controls.map((control) => control.launch.cwd).sort()).toEqual(
        runs.map((run) => run.cwd).sort(),
      );
      expect(yield* service.workspaceReview(runs[0]!.workspaceId!).pipe(Effect.flip)).toMatchObject(
        { code: "workspace_process_unsettled" },
      );
    });
  });

  it.effect(
    "requires complete immutable review and source lease before uncommitted integration",
    () => {
      const f = fixture();
      return withService(f.layer, function* (service) {
        const run = yield* service.start(request({ cwd: "/repo", writeIntent: "writer" }));
        const id = run.workspaceId!;
        yield* service.stop(run.id);
        expect(f.entries.has(id)).toBe(true);
        const page = yield* service.workspaceReview(id);
        expect(page.nextOffset).toBe(16_000);
        expect(
          yield* service.workspacePrepare(id, page.revisionId).pipe(Effect.flip),
        ).toMatchObject({ code: "workspace_review_incomplete" });
        yield* service.workspaceReview(id, {
          revisionId: page.revisionId,
          offset: page.nextOffset ?? 0,
        });
        const prepared = yield* service.workspacePrepare(id, page.revisionId);
        expect(prepared.cwd).toBe("/private/combined");
        yield* service.workspaceIntegrate(id, page.revisionId, prepared.preparationId);
        expect(f.acquired).toContain("/repo");
        expect(f.acquired).toContain("/repo/packages/b");
        expect(f.released).toContain("/repo");
        expect(f.released).toContain("/repo/packages/b");
        expect(f.entries.get(id)?.status).toBe("integrated");
        expect((yield* service.inspectWriterWorkspace).canSwitch).toBe(true);
      });
    },
  );

  it.effect("revision successor retains artifact and invalidates old approval", () => {
    const f = fixture();
    return withService(f.layer, function* (service) {
      const first = yield* service.start(request({ cwd: "/repo", writeIntent: "writer" }));
      yield* service.stop(first.id);
      const review = yield* service.workspaceReview(first.workspaceId!);
      const second = yield* service.workspaceRevise(first.workspaceId!, "Fix the test failure.");
      expect(second.id).not.toBe(first.id);
      expect(second.workspaceId).toBe(first.workspaceId);
      expect(second.cwd).toBe(first.cwd);
      yield* service.stop(second.id);
      expect(
        yield* service
          .workspaceReview(first.workspaceId!, { revisionId: review.revisionId })
          .pipe(Effect.flip),
      ).toMatchObject({ code: "workspace_revision_stale" });
      expect(
        yield* service.workspaceDiscard(first.workspaceId!, "sibling").pipe(Effect.flip),
      ).toMatchObject({ code: "workspace_owner_unavailable" });
    });
  });

  it.effect("discards the workspace of a writer launch interrupted after acquisition", () => {
    const f = fixture();
    return withService(f.layer, function* (service) {
      const acquired = yield* Deferred.make<void>();
      f.hooks.afterCreate = Deferred.succeed(acquired, undefined).pipe(
        Effect.andThen(Effect.never),
      );
      const starting = yield* service
        .start(request({ cwd: "/repo", writeIntent: "writer" }))
        .pipe(Effect.forkChild);
      yield* Deferred.await(acquired);
      yield* Fiber.interrupt(starting);
      expect(f.children.controls).toHaveLength(0);
      expect(f.statuses()).toEqual(["discarded"]);
      expect(yield* service.inspectWriterWorkspace).toMatchObject({ canSwitch: true });
    });
  });

  it.effect("keeps an interrupted launch's workspace discardable when its cleanup fails", () => {
    const f = fixture();
    return withService(f.layer, function* (service) {
      const acquired = yield* Deferred.make<void>();
      f.hooks.afterCreate = Deferred.succeed(acquired, undefined).pipe(
        Effect.andThen(Effect.never),
      );
      f.hooks.failDiscard = true;
      const starting = yield* service
        .start(request({ cwd: "/repo", writeIntent: "writer" }))
        .pipe(Effect.forkChild);
      yield* Deferred.await(acquired);
      yield* Fiber.interrupt(starting);
      f.hooks.failDiscard = false;
      const [entry] = (yield* service.workspaceList()).records;
      expect(entry?.status).toBe("active");
      // Only a live coordinator binding authorizes this, never the owner string alone.
      yield* service.workspaceDiscard(entry!.handle.workspaceId);
      expect(f.statuses()).toEqual(["discarded"]);
    });
  });

  it.effect(
    "rejects a worktree writer at direct-child capacity before acquiring a workspace",
    () => {
      const f = fixture();
      return withService(f.layer, function* (service) {
        yield* service.start(request({ cwd: "/repo", nestingPolicy: policy }));
        expect(
          yield* service
            .start(request({ cwd: "/repo", writeIntent: "writer", nestingPolicy: policy }))
            .pipe(Effect.flip),
        ).toMatchObject({ code: "direct_child_capacity" });
        expect(f.entries.size).toBe(0);
      });
    },
  );

  it.effect("discards the workspace of a writer that loses admission after acquiring it", () => {
    const f = fixture();
    return withService(f.layer, function* (service) {
      const acquired = yield* Deferred.make<void>();
      const proceed = yield* Deferred.make<void>();
      f.hooks.afterCreate = Deferred.succeed(acquired, undefined).pipe(
        Effect.andThen(Deferred.await(proceed)),
      );
      const writer = yield* service
        .start(request({ cwd: "/repo", writeIntent: "writer", nestingPolicy: policy }))
        .pipe(Effect.forkChild);
      yield* Deferred.await(acquired);
      f.hooks.afterCreate = Effect.void;
      // A start under a higher child limit can still take the slot the writer was counting on.
      yield* service.start(
        request({ cwd: "/repo", nestingPolicy: { ...policy, maxDirectChildren: 2 } }),
      );
      yield* Deferred.succeed(proceed, undefined);
      expect(yield* Fiber.join(writer).pipe(Effect.flip)).toMatchObject({
        code: "direct_child_capacity",
      });
      expect(f.statuses()).toEqual(["discarded"]);
      expect(yield* service.inspectWriterWorkspace).toMatchObject({ canSwitch: true });
    });
  });

  it.effect("rejects a capacity-blocked resume without discarding its tested preparation", () => {
    const f = fixture(
      "/repo",
      (cwd) => cwd,
      undefined,
      profileLayerFor({ version: 6, nesting: policy }),
    );
    return withService(f.layer, function* (service) {
      const writer = yield* service.start(request({ cwd: "/repo", writeIntent: "writer" }));
      yield* completeLocalRun(service, f.children.controls[0]!, writer.id, "Done.");
      const tested = yield* reviewAndPrepare(service, writer.workspaceId!);
      yield* service.start(request({ cwd: "/repo" }));
      expect(yield* service.resume(writer.id).pipe(Effect.flip)).toMatchObject({
        code: "direct_child_capacity",
      });
      expect(f.entries.get(writer.workspaceId!)?.status).toBe("prepared");
      yield* service.workspaceIntegrate(
        writer.workspaceId!,
        tested.revisionId,
        tested.preparationId,
      );
      expect(f.entries.get(writer.workspaceId!)?.status).toBe("integrated");
    });
  });

  it.effect("rejects a capacity-blocked revision without discarding its tested preparation", () => {
    const f = fixture();
    return withService(f.layer, function* (service) {
      const writer = yield* service.start(
        request({ cwd: "/repo", writeIntent: "writer", nestingPolicy: policy }),
      );
      yield* service.stop(writer.id);
      const tested = yield* reviewAndPrepare(service, writer.workspaceId!);
      yield* service.start(request({ cwd: "/repo", nestingPolicy: policy }));
      expect(
        yield* service.workspaceRevise(writer.workspaceId!, "Also cover errors.").pipe(Effect.flip),
      ).toMatchObject({ code: "direct_child_capacity" });
      expect(f.entries.get(writer.workspaceId!)?.status).toBe("prepared");
      yield* service.workspaceIntegrate(
        writer.workspaceId!,
        tested.revisionId,
        tested.preparationId,
      );
      expect(f.entries.get(writer.workspaceId!)?.status).toBe("integrated");
    });
  });

  it.effect("keeps the tested preparation when validation refuses a revision successor", () => {
    const f = fixture();
    return withService(f.layer, function* (service) {
      const writer = yield* service.start(
        request({ cwd: "/repo", writeIntent: "writer", task: `Refactor. ${"t".repeat(100_000)}` }),
      );
      yield* service.stop(writer.id);
      const tested = yield* reviewAndPrepare(service, writer.workspaceId!);
      expect(
        yield* service
          .workspaceRevise(writer.workspaceId!, `Also ${"m".repeat(40_000)}`)
          .pipe(Effect.flip),
      ).toMatchObject({ code: "task_too_large" });
      expect(f.entries.get(writer.workspaceId!)?.status).toBe("prepared");
      yield* service.workspaceIntegrate(
        writer.workspaceId!,
        tested.revisionId,
        tested.preparationId,
      );
      expect(f.entries.get(writer.workspaceId!)?.status).toBe("integrated");
    });
  });

  it.effect("keeps a refused revision request out of later successors", () => {
    let failWorkerCwd = false;
    const leases = Layer.effect(
      WriterLeaseService,
      Effect.gen(function* () {
        const base = yield* WriterLeaseService;
        return WriterLeaseService.of({
          ...base,
          canonicalize: (cwd) =>
            failWorkerCwd && cwd.startsWith("/private/")
              ? Effect.fail(new WriterCwdCanonicalizationError({ message: "Fixture failure." }))
              : base.canonicalize(cwd),
        });
      }),
    ).pipe(Layer.provide(fakeWriterLeaseLayer()));
    const f = fixture("/repo", (cwd) => cwd, leases);
    return withService(f.layer, function* (service) {
      const writer = yield* service.start(request({ cwd: "/repo", writeIntent: "writer" }));
      yield* service.stop(writer.id);
      yield* reviewAndPrepare(service, writer.workspaceId!);
      failWorkerCwd = true;
      expect(
        yield* service.workspaceRevise(writer.workspaceId!, "Try approach A.").pipe(Effect.flip),
      ).toMatchObject({ code: "writer_cwd_canonicalization_failed" });
      failWorkerCwd = false;
      expect(f.entries.get(writer.workspaceId!)?.status).toBe("prepared");
      const successor = yield* service.workspaceRevise(writer.workspaceId!, "Try approach B.");
      expect(successor.task).toContain("Try approach B.");
      expect(successor.task).not.toContain("Try approach A.");
    });
  });

  it.effect("keeps an abandoned revision's hold until its successor is admitted", () => {
    let successorGate: Effect.Effect<void> | undefined;
    // Pauses the successor's launch inside admission, at its worker-cwd canonicalization.
    const leases = Layer.effect(
      WriterLeaseService,
      Effect.gen(function* () {
        const base = yield* WriterLeaseService;
        return WriterLeaseService.of({
          ...base,
          canonicalize: (cwd) =>
            Effect.suspend(() =>
              cwd.startsWith("/private/") && successorGate ? successorGate : Effect.void,
            ).pipe(Effect.andThen(base.canonicalize(cwd))),
        });
      }),
    ).pipe(Layer.provide(fakeWriterLeaseLayer()));
    const f = fixture("/repo", (cwd) => cwd, leases);
    return withService(f.layer, function* (service) {
      const writer = yield* service.start(request({ cwd: "/repo", writeIntent: "writer" }));
      const id = writer.workspaceId!;
      yield* service.stop(writer.id);
      const tested = yield* reviewAndPrepare(service, id);
      const admission = yield* pauseAt;
      successorGate = admission.pause;
      const revising = yield* service
        .workspaceRevise(id, "Cover the error path.")
        .pipe(Effect.forkChild);
      yield* Deferred.await(admission.entered);
      successorGate = undefined;
      // The caller abandons the revise; its successor keeps launching and keeps the workspace.
      yield* Fiber.interrupt(revising);
      const discard = yield* service.workspaceDiscard(id).pipe(Effect.result);
      expect(Result.isFailure(discard) ? discard.failure : "discarded").toMatchObject({
        code: "workspace_process_unsettled",
      });
      expect(yield* service.workspaceRevise(id, "Try again.").pipe(Effect.flip)).toMatchObject({
        code: "workspace_process_unsettled",
      });
      yield* Deferred.succeed(admission.release, undefined);
      yield* yieldUntil(() => f.children.controls[1]?.sent("prompt") === true);
      const successor = (yield* service.list).find(
        (run) => run.workspaceId === id && run.id !== writer.id,
      );
      expect(successor?.task).toContain("Cover the error path.");
      yield* completeLocalRun(service, f.children.controls[1]!, successor!.id, "Done.");
      // Admission committed the revision: the old pair is stale and the next review reopens.
      const [listed] = (yield* service.workspaceList()).records;
      expect(listed).toMatchObject({ status: "active" });
      expect(
        yield* service
          .workspaceIntegrate(id, tested.revisionId, tested.preparationId)
          .pipe(Effect.flip),
      ).toMatchObject({ code: "workspace_preparation_stale" });
      const retested = yield* reviewAndPrepare(service, id);
      expect(retested.revisionId).not.toBe(tested.revisionId);
    });
  });

  it.effect("invalidates the tested preparation once a resumed writer is admitted", () => {
    const f = fixture();
    return withService(f.layer, function* (service) {
      const writer = yield* service.start(request({ cwd: "/repo", writeIntent: "writer" }));
      const id = writer.workspaceId!;
      yield* completeLocalRun(service, f.children.controls[0]!, writer.id, "Done.");
      const tested = yield* reviewAndPrepare(service, id);
      expect((yield* service.resume(writer.id)).state).toBe("running");
      yield* completeLocalRun(service, f.children.controls[1]!, writer.id, "Done again.");
      const [listed] = (yield* service.workspaceList()).records;
      expect(listed).toMatchObject({ status: "active" });
      expect(listed?.preparation).toBeUndefined();
      expect(
        yield* service
          .workspaceIntegrate(id, tested.revisionId, tested.preparationId)
          .pipe(Effect.flip),
      ).toMatchObject({ code: "workspace_preparation_stale" });
      expect(
        yield* service.workspaceReview(id, { revisionId: tested.revisionId }).pipe(Effect.flip),
      ).toMatchObject({ code: "workspace_revision_stale" });
      const retested = yield* reviewAndPrepare(service, id);
      expect(retested.revisionId).not.toBe(tested.revisionId);
      yield* service.workspaceIntegrate(id, retested.revisionId, retested.preparationId);
      expect(f.entries.get(id)?.status).toBe("integrated");
    });
  });

  it.effect("never invalidates the tested preparation for a resume it refuses", () => {
    // The direct-child limit is 2 when the resume is first checked and 1 afterwards.
    const limits: number[] = [];
    const profiles = Layer.effect(
      SubagentProfileService,
      Effect.gen(function* () {
        const base = yield* SubagentProfileService;
        return SubagentProfileService.of({
          ...base,
          capture: base.capture.pipe(
            Effect.map((snapshot) => {
              const maxDirectChildren = limits.shift();
              return maxDirectChildren === undefined
                ? snapshot
                : {
                    ...snapshot,
                    effectiveConfig: {
                      ...snapshot.effectiveConfig,
                      nesting: { ...snapshot.effectiveConfig.nesting, maxDirectChildren },
                    },
                  };
            }),
          ),
        });
      }),
    ).pipe(Layer.provide(profileLayerFor({ version: 6, nesting: policy })));
    const f = fixture("/repo", (cwd) => cwd, undefined, profiles);
    return withService(f.layer, function* (service) {
      const writer = yield* service.start(request({ cwd: "/repo", writeIntent: "writer" }));
      const id = writer.workspaceId!;
      yield* completeLocalRun(service, f.children.controls[0]!, writer.id, "Done.");
      const tested = yield* reviewAndPrepare(service, id);
      yield* service.start(request({ cwd: "/repo" }));
      limits.push(2);
      const outcome = yield* service.resume(writer.id).pipe(Effect.result);
      // Either the resume took the workspace, or the workspace kept its tested preparation.
      expect(Result.isSuccess(outcome) || f.entries.get(id)?.status === "prepared").toBe(true);
      if (Result.isFailure(outcome))
        yield* service.workspaceIntegrate(id, tested.revisionId, tested.preparationId);
    });
  });

  it.effect("refuses to resume or revise a writer whose workspace was integrated", () => {
    const f = fixture();
    return withService(f.layer, function* (service) {
      const writer = yield* service.start(request({ cwd: "/repo", writeIntent: "writer" }));
      const id = writer.workspaceId!;
      yield* completeLocalRun(service, f.children.controls[0]!, writer.id, "Done.");
      const tested = yield* reviewAndPrepare(service, id);
      yield* service.workspaceIntegrate(id, tested.revisionId, tested.preparationId);
      expect(yield* service.resume(writer.id).pipe(Effect.flip)).toMatchObject({
        code: "workspace_finished",
      });
      expect(
        yield* service.workspaceRevise(id, "One more change.").pipe(Effect.flip),
      ).toMatchObject({ code: "workspace_finished" });
      expect(f.children.controls).toHaveLength(1);
      // A worker kept after integration can still be discarded.
      yield* service.workspaceDiscard(id);
      expect(f.entries.get(id)?.status).toBe("discarded");
    });
  });

  it.effect("resumes an interrupted worktree writer whose process is still alive", () => {
    const f = fixture();
    return withService(f.layer, function* (service) {
      const writer = yield* service.start(request({ cwd: "/repo", writeIntent: "writer" }));
      expect((yield* service.interrupt(writer.id)).state).toBe("paused");
      expect((yield* service.resume(writer.id, "Take approach B.")).state).toBe("running");
      expect(f.children.controls).toHaveLength(1);
      expect(f.entries.get(writer.workspaceId!)?.status).toBe("active");
    });
  });

  it.effect(
    "acquires no workspace for a worktree launch that only an acquiring launch blocks",
    () => {
      const f = fixture();
      return withService(f.layer, function* (service) {
        const writer = () =>
          service.start(request({ cwd: "/repo", writeIntent: "writer", nestingPolicy: policy }));
        const acquired = yield* Deferred.make<void>();
        const proceed = yield* Deferred.make<void>();
        f.hooks.afterCreate = Deferred.succeed(acquired, undefined).pipe(
          Effect.andThen(Deferred.await(proceed)),
        );
        const first = yield* writer().pipe(Effect.forkChild);
        yield* Deferred.await(acquired);
        f.hooks.afterCreate = Effect.void;
        const second = yield* writer().pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        expect(f.entries.size).toBe(1);
        yield* Deferred.succeed(proceed, undefined);
        expect((yield* Fiber.join(first)).state).toBe("running");
        expect(yield* Fiber.join(second).pipe(Effect.flip)).toMatchObject({
          code: "direct_child_capacity",
        });
        expect(f.statuses()).toEqual(["active"]);
      });
    },
  );

  it.effect("starts a waiting worktree launch once the acquiring launch gives up", () => {
    const f = fixture();
    return withService(f.layer, function* (service) {
      const writer = () =>
        service.start(request({ cwd: "/repo", writeIntent: "writer", nestingPolicy: policy }));
      const acquired = yield* Deferred.make<void>();
      f.hooks.afterCreate = Deferred.succeed(acquired, undefined).pipe(
        Effect.andThen(Effect.never),
      );
      const first = yield* writer().pipe(Effect.forkChild);
      yield* Deferred.await(acquired);
      f.hooks.afterCreate = Effect.void;
      const second = yield* writer().pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(f.entries.size).toBe(1);
      yield* Fiber.interrupt(first);
      expect((yield* Fiber.join(second)).state).toBe("running");
      expect(f.statuses()).toEqual(["discarded", "active"]);
    });
  });

  it.effect("keeps a slot an acquiring worktree launch holds from other starts", () => {
    const f = fixture();
    return withService(f.layer, function* (service) {
      const acquired = yield* Deferred.make<void>();
      f.hooks.afterCreate = Deferred.succeed(acquired, undefined).pipe(
        Effect.andThen(Effect.never),
      );
      const writer = yield* service
        .start(request({ cwd: "/repo", writeIntent: "writer", nestingPolicy: policy }))
        .pipe(Effect.forkChild);
      yield* Deferred.await(acquired);
      // A reader admitted now would make the writer discard the workspace it just acquired.
      expect(
        yield* service.start(request({ cwd: "/repo", nestingPolicy: policy })).pipe(Effect.flip),
      ).toMatchObject({ code: "direct_child_capacity" });
      const before = yield* service.admissionRevision;
      yield* Fiber.interrupt(writer);
      // Giving the slot back counts as an admission change, so queued starts retry.
      expect(yield* service.admissionRevision).toBeGreaterThan(before);
      expect((yield* service.start(request({ cwd: "/repo", nestingPolicy: policy }))).state).toBe(
        "running",
      );
    });
  });

  it.effect("frees a failed worktree launch's slot before discarding its workspace", () => {
    const f = fixture();
    return withService(f.layer, function* (service) {
      const acquired = yield* Deferred.make<void>();
      f.hooks.afterCreate = Deferred.succeed(acquired, undefined).pipe(
        Effect.andThen(Effect.never),
      );
      const discard = yield* pauseAt;
      f.hooks.before.discard = discard.pause;
      const writer = yield* service
        .start(request({ cwd: "/repo", writeIntent: "writer", nestingPolicy: policy }))
        .pipe(Effect.forkChild);
      yield* Deferred.await(acquired);
      const interrupting = yield* Fiber.interrupt(writer).pipe(Effect.forkChild);
      yield* Deferred.await(discard.entered);
      // The interrupted launch can never be admitted, so its discard holds no direct-child slot.
      const reader = yield* service
        .start(request({ cwd: "/repo", nestingPolicy: policy }))
        .pipe(Effect.result);
      yield* Deferred.succeed(discard.release, undefined);
      yield* Fiber.join(interrupting);
      expect(Result.isSuccess(reader) && reader.success.state).toBe("running");
      expect(f.statuses()).toEqual(["discarded"]);
    });
  });

  it.effect("counts a worktree launch that evicts history once while it reclaims", () => {
    let reclaimGate: Deferred.Deferred<void> | undefined;
    const children = fakeChildLayer(Effect.void, {
      get reclaimGate() {
        return reclaimGate;
      },
    });
    const f = fixture("/repo", (cwd) => cwd, undefined, undefined, children);
    const pair = { maxDirectChildren: 2, maxDepth: 3 };
    return withService(f.layer, function* (service) {
      const history: string[] = [];
      for (let index = 0; index < 50; index += 1) {
        const run = yield* service.start(request({ cwd: "/repo", name: `history-${index}` }));
        history.push(run.id);
        yield* completeLocalRun(service, children.controls[index]!, run.id, `Report ${index}`);
      }
      yield* TestClock.adjust("100 millis");
      const writerReclaim = yield* Deferred.make<void>();
      reclaimGate = writerReclaim;
      const writer = yield* service
        .start(request({ cwd: "/repo", writeIntent: "writer", nestingPolicy: pair }))
        .pipe(Effect.forkChild);
      yield* yieldUntil(() => children.reclaimedRunIds.includes(history[0]!));
      reclaimGate = undefined;
      // The writer's eviction claim already reserves its slot, so one slot remains for a reader.
      const reader = yield* service
        .start(request({ cwd: "/repo", name: "reader", nestingPolicy: pair }))
        .pipe(Effect.result);
      yield* Deferred.succeed(writerReclaim, undefined);
      expect((yield* Fiber.join(writer)).state).toBe("running");
      expect(Result.isSuccess(reader) && reader.success.state).toBe("running");
    });
  });

  for (const operation of ["freeze", "prepare", "discard"] as const)
    it.effect(`runs a root workspace ${operation} outside the run lock`, () => {
      const f = fixture();
      return withService(f.layer, function* (service) {
        const writer = yield* service.start(request({ cwd: "/repo", writeIntent: "writer" }));
        yield* service.stop(writer.id);
        const id = writer.workspaceId!;
        const first = yield* service.workspaceReview(id);
        yield* service.workspaceReview(id, {
          revisionId: first.revisionId,
          offset: first.nextOffset!,
        });
        const { entered, release, pause } = yield* pauseAt;
        f.hooks.before[operation] = pause;
        const running = yield* (
          operation === "freeze"
            ? service.workspaceReview(id).pipe(Effect.asVoid)
            : operation === "prepare"
              ? service.workspacePrepare(id, first.revisionId).pipe(Effect.asVoid)
              : service.workspaceDiscard(id)
        ).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        f.hooks.before[operation] = undefined;
        // Deadlocks if the operation holds the run lock while the engine works.
        yield* service.rename(writer.id, "still-responsive");
        // A second root operation on the workspace queues rather than being refused as busy.
        const queuedReview = yield* service
          .workspaceReview(id, { revisionId: first.revisionId })
          .pipe(Effect.result, Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(running);
        expect(yield* Fiber.join(queuedReview)).not.toMatchObject({
          failure: { code: "workspace_operation_in_progress" },
        });
      });
    });

  it.effect(
    "starts a revision successor without its workflow membership or result contract",
    () => {
      const f = fixture();
      return withService(f.layer, function* (service) {
        const resultContract = yield* compileResultContract({
          type: "object",
          properties: { fixed: { type: "boolean" } },
          required: ["fixed"],
          additionalProperties: false,
        }).pipe(Effect.orDie);
        const writer = yield* service.start(
          request({
            cwd: "/repo",
            writeIntent: "writer",
            workflow: { workflowId: "workflow-1", name: "fix lint" },
            resultContract,
          }),
        );
        expect(writer.workflow?.workflowId).toBe("workflow-1");
        expect(f.children.controls[0]?.launch.resultContract).toBeDefined();
        yield* service.stop(writer.id);
        const successor = yield* service.workspaceRevise(writer.workspaceId!, "Update the tests.");
        expect(successor.workspaceId).toBe(writer.workspaceId);
        expect(successor.workflow).toBeUndefined();
        expect(f.children.controls[1]?.launch.resultContract).toBeUndefined();
      });
    },
  );

  it.effect("keeps a committed integration when a source lease release fails", () => {
    const leases = Layer.effect(
      WriterLeaseService,
      Effect.gen(function* () {
        const base = yield* WriterLeaseService;
        return WriterLeaseService.of({
          ...base,
          release: (lease) =>
            lease.canonicalCwd === "/repo"
              ? Effect.fail(new WriterLeaseReleaseError({ message: "Release unconfirmed." }))
              : base.release(lease),
        });
      }),
    ).pipe(Layer.provide(fakeWriterLeaseLayer()));
    const f = fixture("/repo", (cwd) => cwd, leases);
    return withService(f.layer, function* (service) {
      const writer = yield* service.start(request({ cwd: "/repo", writeIntent: "writer" }));
      yield* service.stop(writer.id);
      const tested = yield* reviewAndPrepare(service, writer.workspaceId!);
      const outcome = yield* service.workspaceIntegrate(
        writer.workspaceId!,
        tested.revisionId,
        tested.preparationId,
      );
      expect(f.entries.get(writer.workspaceId!)?.status).toBe("integrated");
      expect(outcome.leaseReleaseUnconfirmed).toBe(true);
      // The unconfirmed source lease still blocks later writers and integrations.
      expect(
        yield* service.start(request({ cwd: "/repo", writeIntent: "writer" })).pipe(Effect.flip),
      ).toMatchObject({ code: "workspace_integration_quarantined" });
      expect(
        yield* service
          .workspaceIntegrate(writer.workspaceId!, tested.revisionId, tested.preparationId)
          .pipe(Effect.flip),
      ).toMatchObject({ code: "workspace_integration_quarantined" });
    });
  });

  it.effect("keeps integrated proposal trees only while a live run still uses them", () => {
    const f = fixture();
    return withService(f.layer, function* (service) {
      const occupied = yield* service.start(request({ cwd: "/repo", writeIntent: "writer" }));
      const reader = yield* service.startSessionOwnedFrom(occupied.id, request());
      yield* completeLocalRun(service, f.children.controls[0]!, occupied.id);
      expect((yield* service.status(reader.id)).state).toBe("running");
      const first = yield* reviewAndPrepare(service, occupied.workspaceId!);
      yield* service.workspaceIntegrate(
        occupied.workspaceId!,
        first.revisionId,
        first.preparationId,
      );
      const vacant = yield* service.start(request({ cwd: "/repo", writeIntent: "writer" }));
      yield* service.stop(vacant.id);
      const second = yield* reviewAndPrepare(service, vacant.workspaceId!);
      yield* service.workspaceIntegrate(
        vacant.workspaceId!,
        second.revisionId,
        second.preparationId,
      );
      expect(f.integrations.map((target) => [target.workspaceId, target.retainTrees])).toEqual([
        [occupied.workspaceId, true],
        [vacant.workspaceId, false],
      ]);
    });
  });

  it.effect("keeps read-only launches in source and atomically persists mode switches", () => {
    const f = fixture();
    return withService(f.layer, function* (service) {
      const readOnly = yield* service.start(request({ cwd: "/repo", writeIntent: "read-only" }));
      expect(readOnly.cwd).toBe("/repo");
      expect(readOnly.workspaceId).toBeUndefined();
      expect(f.entries.size).toBe(0);
      const failure = yield* service
        .setWriterWorkspaceMode("shared-checkout", Effect.fail("save failed"))
        .pipe(Effect.flip);
      expect(failure).toBe("save failed");
      expect((yield* service.inspectWriterWorkspace).mode).toBe("worktree");
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const saving = yield* service
        .setWriterWorkspaceMode(
          "shared-checkout",
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const starting = yield* service
        .start(request({ cwd: "/repo", writeIntent: "writer" }))
        .pipe(Effect.forkChild);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(saving);
      const writer = yield* Fiber.join(starting);
      expect(writer.cwd).toBe("/repo");
      expect(writer.writerWorkspaceMode).toBe("shared-checkout");
      expect(
        yield* service.setWriterWorkspaceMode("worktree", Effect.void).pipe(Effect.flip),
      ).toMatchObject({ code: "workspace_mode_busy" });
    });
  });
});
