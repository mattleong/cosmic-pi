import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import { nodeFsPromises as fs, nodePath as path } from "../../src/boundary/node-builtins.ts";
import * as os from "node:os";
import { WriterLeaseService } from "../../src/boundary/writer-lease.ts";
import {
  WorkspaceError,
  type UnavailableWorkspaceArtifact,
  type WorkspaceRecord,
  type WorkspaceTarget,
} from "../../src/workspace/model.ts";
import { WorkspaceService, type WorkspaceServiceContract } from "../../src/workspace/service.ts";
import type { SubagentServiceContract } from "../../src/run/service.ts";
import {
  fakeChildLayer,
  fakeWriterLeaseLayer,
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

function fixture(
  sourceCwd = "/repo",
  canonicalize = (cwd: string) => cwd,
  writerLeases?: Layer.Layer<WriterLeaseService>,
) {
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
      return handle;
    });
  const engine: WorkspaceServiceContract = {
    create,
    inspect: requireEntry,
    list: ({ ownerId }) =>
      Effect.sync(() => [...entries.values()].filter((entry) => entry.handle.ownerId === ownerId)),
    listAll: () => Effect.sync(() => ({ records: [...entries.values()], unavailable })),
    freeze: (target) =>
      requireEntry(target).pipe(
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
      requireEntry(target).pipe(
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
          const integrated = { ...entry, status: "integrated" as const };
          entries.set(target.workspaceId, integrated);
          return integrated;
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
          create({ sourceCwd: entry.handle.sourceCwd, ownerId: entry.handle.ownerId }),
        ),
      ),
    discard: (target) =>
      requireEntry(target).pipe(
        Effect.map((entry) => {
          entries.set(target.workspaceId, { ...entry, status: "discarded" });
        }),
      ),
    recoverDiscard: () => Effect.void,
  };
  const acquired: string[] = [];
  const released: string[] = [];
  const canonicalized: string[] = [];
  const children = fakeChildLayer();
  const layer = serviceLayer(
    {
      writerWorkspaceMode: "worktree",
      workspaceOwnerId: "session-1",
      workspaceSourceCwd: sourceCwd,
    },
    undefined,
    writerLeases ??
      fakeWriterLeaseLayer({
        canonicalize,
        onCanonicalize: (cwd) => canonicalized.push(cwd),
        onAcquire: (lease) => acquired.push(lease.canonicalCwd),
        onRelease: (lease) => released.push(lease.canonicalCwd),
      }),
  ).pipe(Layer.provide(children.layer), Layer.provide(Layer.succeed(WorkspaceService, engine)));
  return { entries, unavailable, engine, children, layer, acquired, released, canonicalized };
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
