import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import { temporaryDirectory } from "pi-cosmic-core/testing";
import { nodeFsPromises as fs, nodePath as path } from "../../src/boundary/node-builtins.ts";
import { WriterLeaseReleaseError, WriterLeaseService } from "../../src/boundary/writer-lease.ts";
import { revisionSummary } from "../../src/workspace/diffstat.ts";
import { WorkspaceError, type WorkspaceRecord } from "../../src/workspace/model.ts";
import type { StartSubagentRequest } from "../../src/run/model.ts";
import {
  completeLocalRun,
  fakeWriterLeaseLayer,
  request,
  withService,
} from "./fixtures/service-harness.ts";
import {
  gateCreate,
  leasesWith,
  pauseAt,
  repoWriter,
  reviewAndPrepare,
  stoppedWriter,
  workspaceFixture as fixture,
} from "./fixtures/workspace-engine.ts";

const record = (
  workspaceId: string,
  ownerId: string,
  sourceRoot: string,
  status: WorkspaceRecord["status"],
): WorkspaceRecord => ({
  version: 2,
  repository: "/repo/.git",
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

const sourceLeases = (cwds: ReadonlyArray<string>) =>
  cwds.filter((cwd) => cwd === "/repo" || cwd === "/repo/packages/b").toSorted();

const sharedWriter = (overrides: Partial<StartSubagentRequest> = {}) =>
  repoWriter({ writerWorkspaceModeOverride: "shared-checkout", ...overrides });

interface CanonicalizeGate {
  cwd?: string;
  pause: Effect.Effect<void>;
}

/** Pauses writer cwd canonicalization for one directory, holding its launch before admission. */
const canonicalizeGate = () => {
  const gate: CanonicalizeGate = { pause: Effect.void };
  const writerLeases = leasesWith((base) => ({
    canonicalize: (cwd) =>
      (cwd === gate.cwd ? gate.pause : Effect.void).pipe(Effect.andThen(base.canonicalize(cwd))),
  }));
  return { gate, writerLeases };
};

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
      yield* service.setWriterWorkspaceMode("shared-checkout", Effect.void);
      expect(yield* service.inspectWriterWorkspace).toEqual({
        mode: "shared-checkout",
        unresolvedWorkspaceCount: 1,
      });
    });
  });

  it.effect("refuses orphan discard without original directory identity", () => {
    const f = fixture();
    f.hooks.orphanOwnerEnded = true;
    const original = record("unready", "old-session/root", "/repo", "active");
    const { writerCwd: _identity, ...handle } = original.handle;
    f.entries.set("unready", { ...original, handle });
    return withService(f.layer, function* (service) {
      expect(yield* service.workspaceDiscard("unready").pipe(Effect.flip)).toMatchObject({
        code: "workspace_process_unsettled",
      });
      expect(f.entries.get("unready")?.status).toBe("active");
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
          .workspaceApply(id, {
            revisionId: tested.revisionId,
            preparationId: tested.preparationId,
          })
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
      expect(yield* service.list).toHaveLength(1);
    });
  });

  it.effect("nested readers inspect their parent's effective cwd without a workspace", () => {
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
      expect(f.entries.size).toBe(1);
    });
  });

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
        yield* service.workspaceApply(id, {
          revisionId: page.revisionId,
          preparationId: prepared.preparationId,
        });
        expect(f.acquired).toContain("/repo");
        expect(f.acquired).toContain("/repo/packages/b");
        expect(f.released).toContain("/repo");
        expect(f.released).toContain("/repo/packages/b");
        expect(f.entries.get(id)?.status).toBe("integrated");
        expect(yield* service.inspectWriterWorkspace).toEqual({ mode: "worktree" });
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
      expect(yield* service.inspectWriterWorkspace).toEqual({ mode: "worktree" });
    });
  });

  it.effect("refuses to resume or revise a writer whose workspace was integrated", () => {
    const f = fixture();
    return withService(f.layer, function* (service) {
      const writer = yield* service.start(repoWriter());
      const id = writer.workspaceId!;
      yield* completeLocalRun(service, f.children.controls[0]!, writer.id, "Done.");
      const tested = yield* reviewAndPrepare(service, id);
      yield* service.workspaceApply(id, {
        revisionId: tested.revisionId,
        preparationId: tested.preparationId,
      });
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

  it.effect("keeps a stopped integration's source leases until discard rolls it back", () => {
    const f = fixture();
    f.hooks.integrateStops = true;
    return withService(f.layer, function* (service) {
      const id = (yield* stoppedWriter(service)).workspaceId!;
      const tested = yield* reviewAndPrepare(service, id);
      yield* service
        .workspaceApply(id, { revisionId: tested.revisionId, preparationId: tested.preparationId })
        .pipe(Effect.flip);
      expect(f.entries.get(id)?.status).toBe("integrating");
      expect(sourceLeases(f.acquired)).toEqual(["/repo", "/repo/packages/b"]);
      expect(sourceLeases(f.released)).toEqual([]);
      // Only this workspace is stuck: other worktree writers still start.
      const other = yield* stoppedWriter(service);
      expect(other.workspaceId).toBeDefined();
      yield* service.workspaceDiscard(id);
      expect(f.entries.get(id)?.status).toBe("discarded");
      expect(sourceLeases(f.released)).toEqual(["/repo", "/repo/packages/b"]);
    });
  });

  it.effect("pages a review without splitting a character", () => {
    const f = fixture();
    // The review text leads with the revision's summary, which doesn't depend on its id.
    const summary = revisionSummary({ revisionId: "", changedPaths: ["file.ts"], diff: "" });
    const diff = `${"x".repeat(15_999 - summary.length)}\u{1F600}${"y".repeat(10)}`;
    f.hooks.revisionDiff = diff;
    return withService(f.layer, function* (service) {
      const id = (yield* stoppedWriter(service)).workspaceId!;
      const first = yield* service.workspaceReview(id);
      const second = yield* service.workspaceReview(id, {
        revisionId: first.revisionId,
        offset: first.nextOffset!,
      });
      // A lone surrogate at either edge of a page would be half a character.
      expect(first.text).not.toMatch(/[\uD800-\uDBFF]$/u);
      expect(second.text).not.toMatch(/^[\uDC00-\uDFFF]/u);
      expect(`${first.text}${second.text}`).toBe(`${summary}${diff}`);
      yield* service.workspacePrepare(id, first.revisionId);
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
      const integrate = service.workspaceApply(id, {
        revisionId: tested.revisionId,
        preparationId: tested.preparationId,
      });
      const outcome = yield* integrate;
      expect(f.entries.get(id)?.status).toBe("integrated");
      expect(outcome).toMatchObject({ integrated: true, leaseReleaseUnconfirmed: true });
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
      yield* service.setWriterWorkspaceMode("worktree", Effect.void);
      expect(yield* service.status(writer.id)).toMatchObject({
        cwd: "/repo",
        writerWorkspaceMode: "shared-checkout",
      });
    });
  });

  it.effect("launches each writer in its own isolation and the rest in the default", () => {
    const f = fixture();
    return withService(f.layer, function* (service) {
      yield* service.setWriterWorkspaceMode("shared-checkout", Effect.void);
      const isolated = yield* service.start(
        repoWriter({ writerWorkspaceModeOverride: "worktree" }),
      );
      const shared = yield* service.start(repoWriter());
      expect(isolated).toMatchObject({ writerWorkspaceMode: "worktree" });
      expect(isolated.workspaceId).toBeDefined();
      expect(isolated.cwd).toBe(f.entries.get(isolated.workspaceId!)?.handle.cwd);
      expect(shared).toMatchObject({ cwd: "/repo", writerWorkspaceMode: "shared-checkout" });
      expect(shared.workspaceId).toBeUndefined();
      expect(f.acquired).toContain("/repo");
      expect(f.entries.size).toBe(1);
    });
  });

  it.effect("launches a shared-checkout writer in source when the default is worktree", () => {
    const f = fixture();
    return withService(f.layer, function* (service) {
      const writer = yield* service.start(sharedWriter());
      expect(writer).toMatchObject({ cwd: "/repo", writerWorkspaceMode: "shared-checkout" });
      expect(writer.workspaceId).toBeUndefined();
      expect(f.entries.size).toBe(0);
    });
  });

  it.effect("ignores isolation for read-only launches", () => {
    const f = fixture();
    return withService(f.layer, function* (service) {
      const reader = yield* service.start(
        request({
          cwd: "/repo",
          writeIntent: "read-only",
          writerWorkspaceModeOverride: "worktree",
        }),
      );
      expect(reader.cwd).toBe("/repo");
      expect(reader.workspaceId).toBeUndefined();
      expect(reader.writerWorkspaceMode).toBeUndefined();
      expect(f.entries.size).toBe(0);
    });
  });

  it.effect("integration waits only for shared-checkout writers in the target checkout", () => {
    const { gate, writerLeases } = canonicalizeGate();
    const f = fixture({ writerLeases });
    return withService(f.layer, function* (service) {
      const id = (yield* stoppedWriter(service)).workspaceId!;
      const tested = yield* reviewAndPrepare(service, id);
      const integrate = service.workspaceApply(id, {
        revisionId: tested.revisionId,
        preparationId: tested.preparationId,
      });
      yield* service.start(sharedWriter({ cwd: "/elsewhere" }));
      for (const cwd of ["/repo", "/repo/packages/a", "/"]) {
        const writer = yield* service.start(sharedWriter({ cwd }));
        expect(yield* integrate.pipe(Effect.flip)).toMatchObject({ code: "workspace_target_busy" });
        yield* service.stop(writer.id);
      }
      const reserved = yield* pauseAt;
      gate.cwd = "/repo/packages/a";
      gate.pause = reserved.pause;
      const launching = yield* service
        .start(sharedWriter({ cwd: "/repo/packages/a" }))
        .pipe(Effect.forkChild);
      yield* Deferred.await(reserved.entered);
      expect(yield* integrate.pipe(Effect.flip)).toMatchObject({ code: "workspace_target_busy" });
      yield* Deferred.succeed(reserved.release, undefined);
      yield* service.stop((yield* Fiber.join(launching)).id);
      const create = yield* gateCreate(f);
      const creating = yield* service.start(repoWriter()).pipe(Effect.forkChild);
      yield* Deferred.await(create.entered);
      yield* integrate;
      expect(f.entries.get(id)?.status).toBe("integrated");
      yield* Deferred.succeed(create.release, undefined);
      expect((yield* Fiber.join(creating)).workspaceId).toBeDefined();
    });
  });
});
