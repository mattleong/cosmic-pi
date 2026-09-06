import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { provideBuiltLayer } from "pi-cosmic-core";
import { SubagentService } from "../../src/run/service.ts";
import {
  WorkspaceError,
  type WorkspaceRecord,
  type WorkspaceTarget,
} from "../../src/workspace/model.ts";
import { WorkspaceService, type WorkspaceServiceContract } from "../../src/workspace/service.ts";
import {
  fakeChildLayer,
  fakeWriterLeaseLayer,
  request,
  serviceLayer,
} from "./fixtures/service-harness.ts";

function fixture(sourceCwd = "/repo", canonicalize = (cwd: string) => cwd) {
  const entries = new Map<string, WorkspaceRecord>();
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
    listAll: () => Effect.sync(() => [...entries.values()]),
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
    fakeWriterLeaseLayer({
      canonicalize,
      onCanonicalize: (cwd) => canonicalized.push(cwd),
      onAcquire: (lease) => acquired.push(lease.canonicalCwd),
      onRelease: (lease) => released.push(lease.canonicalCwd),
    }),
  ).pipe(Layer.provide(children.layer), Layer.provide(Layer.succeed(WorkspaceService, engine)));
  return { entries, engine, children, layer, acquired, released, canonicalized };
}

describe("writer workspace orchestration", () => {
  it.effect("shows repository orphans through a cwd alias and blocks mode changes", () => {
    const f = fixture("/alias/package", (cwd) =>
      cwd === "/alias/package" ? "/repo/package" : cwd,
    );
    const orphan = (workspaceId: string, sourceRoot: string): WorkspaceRecord => ({
      version: 1,
      handle: {
        workspaceId,
        ownerId: "old-session/root",
        sourceCwd: sourceRoot,
        sourceRoot,
        cwd: `/private/${workspaceId}`,
      },
      status: "active",
      baseline: "original-base",
    });
    f.entries.set("orphan", orphan("orphan", "/repo"));
    f.entries.set("unrelated", orphan("unrelated", "/repo-other"));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const reader = yield* service.start(
        request({ cwd: "/alias/package", writeIntent: "read-only" }),
      );
      expect(reader.cwd).toBe("/alias/package");
      expect(f.canonicalized).toEqual([]);
      expect(f.acquired).toEqual([]);
      expect(f.entries.size).toBe(2);
      expect((yield* service.workspaceList()).map((entry) => entry.handle.workspaceId)).toEqual([
        "orphan",
      ]);
      expect(yield* service.inspectWriterWorkspace).toMatchObject({ canSwitch: false });
      let persisted = false;
      expect(
        yield* service
          .setWriterWorkspaceMode(
            "shared-checkout",
            Effect.sync(() => {
              persisted = true;
            }),
          )
          .pipe(Effect.flip),
      ).toMatchObject({ code: "workspace_mode_busy" });
      expect(persisted).toBe(false);
      expect(yield* service.workspaceDiscard("orphan").pipe(Effect.flip)).toMatchObject({
        code: "workspace_owner_unavailable",
      });
      f.entries.set("orphan", { ...f.entries.get("orphan")!, status: "discarded" });
      expect(yield* service.inspectWriterWorkspace).toMatchObject({ canSwitch: true });
      expect(f.acquired).toEqual([]);
    }).pipe(Effect.scoped, provideBuiltLayer(f.layer));
  });

  it.effect(
    "nested readers inspect their parent's effective cwd but nested writers fail before artifact creation",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const service = yield* SubagentService;
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
      }).pipe(Effect.scoped, provideBuiltLayer(f.layer));
    },
  );

  it.effect("launches simultaneous claimless writers in distinct private cwd leases", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const service = yield* SubagentService;
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
    }).pipe(Effect.scoped, provideBuiltLayer(f.layer));
  });

  it.effect(
    "requires complete immutable review and source lease before uncommitted integration",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const service = yield* SubagentService;
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
      }).pipe(Effect.scoped, provideBuiltLayer(f.layer));
    },
  );

  it.effect("revision successor retains artifact and invalidates old approval", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const service = yield* SubagentService;
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
    }).pipe(Effect.scoped, provideBuiltLayer(f.layer));
  });

  it.effect("keeps read-only launches in source and atomically persists mode switches", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const service = yield* SubagentService;
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
    }).pipe(Effect.scoped, provideBuiltLayer(f.layer));
  });
});
