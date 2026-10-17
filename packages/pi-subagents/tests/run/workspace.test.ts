import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import { temporaryDirectory } from "pi-cosmic-core/testing";
import { nodeFsPromises as fs, nodePath as path } from "../../src/boundary/node-builtins.ts";
import {
  type WriterLeaseContract,
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
import type { StartSubagentRequest } from "../../src/run/model.ts";
import type { SubagentServiceContract } from "../../src/run/service.ts";
import {
  completeLocalRun,
  fakeChildLayer,
  fakeWriterLeaseLayer,
  type profileLayerFor,
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
    writerCwd: {
      path: `/private/${workspaceId}`,
      filesystemIdentity: `dev:1;ino:/private/${workspaceId}`,
      digest: "1".padStart(64, "0"),
    },
  },
  status,
  baseline: "baseline",
});

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

const repoWriter = (overrides: Partial<StartSubagentRequest> = {}) =>
  request({ cwd: "/repo", writeIntent: "writer", ...overrides });

const stoppedWriter = (
  service: SubagentServiceContract,
  overrides?: Partial<StartSubagentRequest>,
) => service.start(repoWriter(overrides)).pipe(Effect.tap((run) => service.stop(run.id)));

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

const leasesWith = (override: (base: WriterLeaseContract) => Partial<WriterLeaseContract>) =>
  Layer.effect(
    WriterLeaseService,
    WriterLeaseService.use((base) =>
      Effect.succeed(WriterLeaseService.of({ ...base, ...override(base) })),
    ),
  ).pipe(Layer.provide(fakeWriterLeaseLayer()));

type GatedOperation = "freeze" | "prepare" | "discard";

interface EngineHooks {
  afterCreate: Effect.Effect<void>;
  orphanOwnerEnded?: boolean;
  createFailure?: WorkspaceError;
  setupFailure?: WorkspaceError;
  before: { [Operation in GatedOperation]?: Effect.Effect<void> | undefined };
  failDiscard: boolean;
}

const pauseAt = Effect.gen(function* () {
  const entered = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const pause = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)));
  return { entered, release, pause };
});

const gateCreate = (f: ReturnType<typeof fixture>) =>
  pauseAt.pipe(
    Effect.tap(({ pause }) =>
      Effect.sync(() => {
        f.hooks.afterCreate = pause;
      }),
    ),
  );

function fixture({
  sourceCwd = "/repo",
  canonicalize = (cwd: string) => cwd,
  writerLeases,
  profiles,
  children = fakeChildLayer(),
  workspaceSetup,
}: {
  readonly sourceCwd?: string;
  readonly canonicalize?: (cwd: string) => string;
  readonly writerLeases?: Layer.Layer<WriterLeaseService>;
  readonly profiles?: ReturnType<typeof profileLayerFor>;
  readonly children?: ReturnType<typeof fakeChildLayer>;
  readonly workspaceSetup?: { readonly command: ReadonlyArray<string> };
} = {}) {
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
  let preparations = 0;
  const engineFor = (leases: WriterLeaseContract): WorkspaceServiceContract => {
    const create: WorkspaceServiceContract["create"] = (input) =>
      Effect.suspend(() =>
        hooks.createFailure ? Effect.fail(hooks.createFailure) : Effect.void,
      ).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const workspaceId = `workspace-${++ordinal}`;
            const handle = {
              workspaceId,
              ownerId: input.ownerId,
              sourceCwd: input.sourceCwd,
              sourceRoot: input.sourceCwd,
              cwd: `/private/${workspaceId}/worker`,
              writerCwd: yield* leases
                .canonicalize(`/private/${workspaceId}/worker`)
                .pipe(
                  Effect.mapError(
                    (error) => new WorkspaceError({ operation: "create", message: error.message }),
                  ),
                ),
            };
            entries.set(workspaceId, {
              version: 1,
              handle,
              status: "active",
              baseline: "original-base",
            });
            input.onAcquired?.(handle);
            return handle;
          }),
        ),
        Effect.tap(() => hooks.afterCreate),
      );
    return {
      create,
      setup: () =>
        Effect.suspend(() => (hooks.setupFailure ? Effect.fail(hooks.setupFailure) : Effect.void)),
      setupChanges: () => Effect.succeed([]),
      inspect: requireEntry,
      list: ({ ownerId }) =>
        Effect.sync(() =>
          [...entries.values()].filter((entry) => entry.handle.ownerId === ownerId),
        ),
      listAll: Effect.sync(() => ({ records: [...entries.values()], unavailable })),
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
            const preparationId = `prepared-${++preparations}`;
            const preparation = {
              preparationId,
              revisionId: target.revisionId,
              cwd: `/private/${target.workspaceId}/prepare-${preparationId}`,
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
              remainingBackupPaths: [],
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
      discardOrphan: ({ workspaceId }) =>
        Effect.suspend(() => {
          const entry = entries.get(workspaceId);
          if (!entry || !hooks.orphanOwnerEnded)
            return Effect.fail(
              new WorkspaceError({
                operation: "authorization",
                message: "The session that created this workspace is still running.",
              }),
            );
          entries.set(workspaceId, { ...entry, status: "discarded" });
          return Effect.void;
        }),
      discard: (target) =>
        gated("discard", requireEntry(target)).pipe(
          Effect.flatMap((entry) =>
            hooks.failDiscard
              ? Effect.fail(
                  new WorkspaceError({ operation: "discard", message: "Fixture failure" }),
                )
              : Effect.sync(() => {
                  entries.set(target.workspaceId, { ...entry, status: "discarded" });
                }),
          ),
        ),
    };
  };
  const acquired: string[] = [];
  const released: string[] = [];
  const canonicalized: string[] = [];
  const leaseLayer =
    writerLeases ??
    fakeWriterLeaseLayer({
      canonicalize,
      onCanonicalize: (cwd) => canonicalized.push(cwd),
      onAcquire: (lease) => acquired.push(lease.canonicalCwd),
      onRelease: (lease) => released.push(lease.canonicalCwd),
    });
  const layer = serviceLayer(
    {
      writerWorkspaceMode: "worktree",
      workspaceOwnerId: "session-1",
      workspaceSourceCwd: sourceCwd,
      workspaceSetup,
    },
    profiles,
    leaseLayer,
  ).pipe(
    Layer.provide(children.layer),
    Layer.provide(
      Layer.effect(WorkspaceService, Effect.map(WriterLeaseService, engineFor)).pipe(
        Layer.provide(leaseLayer),
      ),
    ),
  );
  const statuses = () => [...entries.values()].map((entry) => entry.status);
  return {
    entries,
    unavailable,
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
  it.effect("refuses admission when the acquired writer directory is replaced", () => {
    let replaced = false;
    const f = fixture({
      writerLeases: leasesWith((base) => ({
        canonicalize: (cwd) =>
          base
            .canonicalize(cwd)
            .pipe(
              Effect.map((identity) =>
                replaced
                  ? { ...identity, filesystemIdentity: "dev:2;ino:3", digest: "f".repeat(64) }
                  : identity,
              ),
            ),
      })),
    });
    f.hooks.afterCreate = Effect.sync(() => {
      replaced = true;
    });
    return withService(f.layer, function* (service) {
      expect(yield* service.start(repoWriter()).pipe(Effect.flip)).toMatchObject({
        code: "writer_cwd_identity_changed",
      });
      expect(yield* service.list).toEqual([]);
    });
  });
  it.effect("retains an unadmitted workspace when setup cleanup is unconfirmed", () => {
    const f = fixture({ workspaceSetup: { command: ["setup"] } });
    f.hooks.setupFailure = new WorkspaceError({
      operation: "setup",
      message: "Setup descendants may remain.",
      cleanupUnconfirmed: true,
    });
    return withService(f.layer, function* (service) {
      expect(yield* service.start(repoWriter()).pipe(Effect.flip)).toMatchObject({
        code: "workspace_setup_cleanup_unconfirmed",
      });
      expect(yield* service.list).toEqual([]);
      const workspaceId = [...f.entries.keys()][0]!;
      expect(f.entries.get(workspaceId)?.status).toBe("active");
      for (const operation of [
        service.workspaceDiscard(workspaceId),
        service.workspaceReview(workspaceId),
        service.workspaceRevise(workspaceId, "Try again"),
      ])
        expect(yield* operation.pipe(Effect.flip)).toMatchObject({
          code: "workspace_process_unsettled",
        });
      yield* expectModeSwitchBlocked(service);
    });
  });

  it.effect("refuses legacy orphan discard without original directory identity", () => {
    const f = fixture();
    f.hooks.orphanOwnerEnded = true;
    const original = record("legacy", "old-session/root", "/repo", "active");
    const { writerCwd: _identity, ...handle } = original.handle;
    f.entries.set("legacy", { ...original, handle });
    return withService(f.layer, function* (service) {
      expect(yield* service.workspaceDiscard("legacy").pipe(Effect.flip)).toMatchObject({
        code: "workspace_process_unsettled",
      });
      expect(f.entries.get("legacy")?.status).toBe("active");
      expect(f.acquired).toEqual([]);
    });
  });
  it.live("releases a real source lease when cancellation lands at acquisition handoff", () =>
    Effect.gen(function* () {
      const temporary = yield* temporaryDirectory("workspace-handoff-");
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
      const f = fixture({ sourceCwd: root, writerLeases: wrapped });
      yield* withService(f.layer, function* (service) {
        const id = (yield* stoppedWriter(service, { cwd: root })).workspaceId!;
        const tested = yield* reviewAndPrepare(service, id);
        const integrating = yield* service
          .workspaceIntegrate(id, tested.revisionId, tested.preparationId)
          .pipe(Effect.forkChild);
        expect(Exit.isFailure(yield* Fiber.await(integrating))).toBe(true);
        expect(f.entries.get(id)?.status).toBe("prepared");
        const replacement = yield* leases.acquire({ cwd, runId: "replacement" });
        yield* leases.release(replacement);
      });
    }).pipe(Effect.scoped),
  );
  it.effect("keeps an orphan while a writer still holds its worker tree", () => {
    const f = fixture({ writerLeases: fakeWriterLeaseLayer({ failAcquire: true }) });
    f.hooks.orphanOwnerEnded = true;
    f.entries.set("orphan", record("orphan", "old-session/root", "/repo", "active"));
    return withService(f.layer, function* (service) {
      expect(yield* service.workspaceDiscard("orphan").pipe(Effect.flip)).toMatchObject({
        code: "workspace_process_unsettled",
      });
      expect(f.entries.get("orphan")?.status).toBe("active");
    });
  });

  it.effect("refuses script-origin writers before workspace creation or reservations", () => {
    const f = fixture();
    return withService(f.layer, function* (service) {
      expect(yield* service.startScriptSessionOwned(repoWriter()).pipe(Effect.flip)).toMatchObject({
        code: "scripted_subtree_writer_not_supported",
      });
      const reader = yield* service.startScriptSessionOwned(request({ cwd: "/repo" }));
      expect(
        yield* service
          .startSessionOwnedFrom(reader.id, request({ writeIntent: "writer" }))
          .pipe(Effect.flip),
      ).toMatchObject({ code: "scripted_subtree_writer_not_supported" });
      expect(f.entries.size).toBe(0);
      expect(f.acquired).toEqual([]);
      expect(f.canonicalized).toEqual([]);
      expect((yield* service.inspectWriterWorkspace).blockedCode).toBeUndefined();
      expect(yield* service.list).toHaveLength(1);
    });
  });

  it.effect(
    "nested readers inspect their parent's effective cwd but nested writers fail before artifact creation",
    () => {
      const f = fixture();
      return withService(f.layer, function* (service) {
        const parent = yield* service.start(repoWriter());
        const child = yield* service.startSessionOwnedFrom(
          parent.id,
          request({ cwd: "/wrong-source", writeIntent: "read-only" }),
        );
        expect(child.cwd).toBe(parent.cwd);
        expect(child.workspaceId).toBeUndefined();
        expect(f.children.controls[1]?.launch.cwd).toBe(parent.cwd);
        const failure = yield* service
          .startSessionOwnedFrom(parent.id, repoWriter())
          .pipe(Effect.flip);
        expect(failure).toMatchObject({ code: "workspace_nested_writer_unsupported" });
        expect(f.entries.size).toBe(1);
      });
    },
  );

  it.effect(
    "requires complete immutable review and source lease before uncommitted integration",
    () => {
      const f = fixture();
      return withService(f.layer, function* (service) {
        const id = (yield* stoppedWriter(service)).workspaceId!;
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
        expect(prepared.cwd).not.toBe("/repo");
        yield* service.workspaceIntegrate(id, page.revisionId, prepared.preparationId);
        expect(f.acquired).toContain("/repo");
        expect(f.acquired).toContain("/repo/packages/b");
        expect(f.released).toContain("/repo");
        expect(f.released).toContain("/repo/packages/b");
        expect(f.entries.get(id)?.status).toBe("integrated");
        expect((yield* service.inspectWriterWorkspace).blockedCode).toBeUndefined();
      });
    },
  );

  it.effect("discards the workspace of a writer launch interrupted after acquisition", () => {
    const f = fixture();
    return withService(f.layer, function* (service) {
      const create = yield* gateCreate(f);
      const starting = yield* service.start(repoWriter()).pipe(Effect.forkChild);
      yield* Deferred.await(create.entered);
      yield* Fiber.interrupt(starting);
      expect(f.children.controls).toHaveLength(0);
      expect(f.statuses()).toEqual(["discarded"]);
      expect((yield* service.inspectWriterWorkspace).blockedCode).toBeUndefined();
    });
  });

  it.effect("refuses to resume or revise a writer whose workspace was integrated", () => {
    const f = fixture();
    return withService(f.layer, function* (service) {
      const writer = yield* service.start(repoWriter());
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
      yield* service.workspaceDiscard(id);
      expect(f.entries.get(id)?.status).toBe("discarded");
    });
  });

  it.effect("holds read-only admission closed throughout destructive discard", () => {
    const f = fixture();
    return withService(f.layer, function* (service) {
      const writer = yield* stoppedWriter(service);
      const gate = yield* pauseAt;
      f.hooks.before.discard = gate.pause;
      const discarding = yield* service
        .workspaceDiscard(writer.workspaceId!)
        .pipe(Effect.forkChild);
      yield* Deferred.await(gate.entered);
      const attempted = yield* Deferred.make<void>();
      const admitted = yield* Deferred.make<void>();
      const starting = yield* Deferred.succeed(attempted, undefined).pipe(
        Effect.andThen(service.start(request({ cwd: writer.cwd }))),
        Effect.tap(() => Deferred.succeed(admitted, undefined)),
        Effect.forkChild,
      );
      yield* Deferred.await(attempted);
      yield* Effect.yieldNow;
      expect(yield* Deferred.isDone(admitted)).toBe(false);
      expect(f.entries.get(writer.workspaceId!)?.status).toBe("active");
      yield* Deferred.succeed(gate.release, undefined);
      yield* Fiber.join(discarding);
      yield* Fiber.join(starting);
      expect(f.entries.get(writer.workspaceId!)?.status).toBe("discarded");
    });
  });

  it.effect("keeps a committed integration when a source lease release fails", () => {
    const f = fixture({
      writerLeases: leasesWith((base) => ({
        release: (lease) =>
          lease.canonicalCwd === "/repo"
            ? Effect.fail(new WriterLeaseReleaseError({ message: "Release unconfirmed." }))
            : base.release(lease),
      })),
    });
    return withService(f.layer, function* (service) {
      const id = (yield* stoppedWriter(service)).workspaceId!;
      const tested = yield* reviewAndPrepare(service, id);
      const integrate = service.workspaceIntegrate(id, tested.revisionId, tested.preparationId);
      const outcome = yield* integrate;
      expect(f.entries.get(id)?.status).toBe("integrated");
      expect(outcome.leaseReleaseUnconfirmed).toBe(true);
      expect(yield* service.start(repoWriter()).pipe(Effect.flip)).toMatchObject({
        code: "workspace_integration_quarantined",
      });
      expect(yield* integrate.pipe(Effect.flip)).toMatchObject({
        code: "workspace_integration_quarantined",
      });
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
      const save = yield* pauseAt;
      const saving = yield* service
        .setWriterWorkspaceMode("shared-checkout", save.pause)
        .pipe(Effect.forkChild);
      yield* Deferred.await(save.entered);
      const starting = yield* service.start(repoWriter()).pipe(Effect.forkChild);
      yield* Deferred.succeed(save.release, undefined);
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
