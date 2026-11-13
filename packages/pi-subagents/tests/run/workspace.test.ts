import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Fn from "effect/Function";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import { temporaryDirectory } from "pi-cosmic-core/testing";
import { nodeFsPromises as fs, nodePath as path } from "../support/node-builtins.ts";
import { WriterLeaseService } from "../../src/boundary/writer-lease.ts";
import { revisionSummary } from "../../src/workspace/diffstat.ts";
import { WorkspaceError } from "../../src/workspace/model.ts";
import type { StartSubagentRequest } from "../../src/run/model.ts";
import { request, runView, runViews, withService } from "./fixtures/service-harness.ts";
import {
  canonicalizeGate,
  completedWriter,
  failingRelease,
  gateCreate,
  heldElsewhere,
  leasesWith,
  pauseAt,
  replacedIdentity,
  repoWriter,
  reviewAndPrepare,
  stoppedWriter,
  workspaceFixture as fixture,
} from "./fixtures/workspace-engine.ts";
import { stringContaining } from "../support/matchers.ts";
import * as Str from "effect/String";

const sharedWriter = (overrides: Partial<StartSubagentRequest> = {}) =>
  repoWriter({ writerWorkspaceModeOverride: "shared-checkout", ...overrides });

describe("writer workspace orchestration", () => {
  it.effect("refuses admission when the acquired writer directory is replaced", () => {
    let replaced = false;
    const f = fixture({ writerLeases: leasesWith(replacedIdentity(() => replaced)) });
    f.hooks.afterCreate = Effect.sync(() => {
      replaced = true;
    });
    return withService(f.layer, function* (service) {
      expect(yield* service.start(repoWriter()).pipe(Effect.flip)).toMatchObject({
        code: "writer_cwd_identity_changed",
      });
      expect(yield* runViews(service)).toEqual([]);
    });
  });
  it.effect("never launches a writer whose WorktreeCreate hook failed", () => {
    const f = fixture({ worktreeCreate: [{ command: ["setup"] }] });
    f.hooks.createHookFailure = WorkspaceError.make({
      operation: "hook",
      message: "WorktreeCreate hook `setup` timed out after 600s.",
    });
    return withService(f.layer, function* (service) {
      expect(yield* service.start(repoWriter()).pipe(Effect.flip)).toMatchObject({
        code: "workspace_hook_failed",
      });
      expect(yield* runViews(service)).toEqual([]);
      expect(f.children.controls).toHaveLength(0);
      expect(f.statuses()).toEqual(["discarded"]);
    });
  });

  it.effect("never launches a writer while its WorktreeCreate setup is invalid", () => {
    const f = fixture({ worktreeCreate: { invalid: ["project.hooks.WorktreeCreate[0]"] } });
    return withService(f.layer, function* (service) {
      expect(yield* service.start(repoWriter()).pipe(Effect.flip)).toMatchObject({
        code: "workspace_hook_failed",
        message: stringContaining("project.hooks.WorktreeCreate[0]"),
      });
      expect(yield* runViews(service)).toEqual([]);
      expect(f.children.controls).toHaveLength(0);
      expect(f.hookRuns).toEqual([]);
      expect(f.statuses()).toEqual(["discarded"]);
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
          leases.canonicalize(Fn.pipe(directory, Str.startsWith("/private/")) ? worker : directory),
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
          .workspaceApply(id, { revisionId: tested.revisionId })
          .pipe(Effect.forkChild);
        expect(Exit.isFailure(yield* Fiber.await(integrating))).toBe(true);
        expect(f.entries.get(id)?.status).toBe("prepared");
        const replacement = yield* leases.acquire({ cwd, runId: "replacement" });
        yield* leases.release(replacement);
      });
    }).pipe(Effect.scoped),
  );
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
      expect(yield* runViews(service)).toHaveLength(1);
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

  it.effect("integrates a tested preparation under the checkout's lease", () => {
    const f = fixture();
    return withService(f.layer, function* (service) {
      const id = (yield* stoppedWriter(service)).workspaceId!;
      expect(f.entries.has(id)).toBe(true);
      const page = yield* service.workspaceReview(id);
      expect(page.nextOffset).toBe(16_000);
      const prepared = yield* service.workspacePrepare(id, page.revisionId);
      expect(prepared.cwd).not.toBe("/repo");
      yield* service.workspaceApply(id, { revisionId: page.revisionId });
      expect(f.acquired).toContain("/repo");
      expect(f.released).toContain("/repo");
      expect(f.entries.get(id)?.status).toBe("integrated");
      expect(yield* service.inspectWriterWorkspace).toEqual({ mode: "worktree" });
    });
  });

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
      const writer = yield* completedWriter(service, f);
      const id = writer.workspaceId!;
      const tested = yield* reviewAndPrepare(service, id);
      yield* service.workspaceApply(id, { revisionId: tested.revisionId });
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

  it.effect(
    "lets only discard follow a stopped integration, releasing the checkout's lease",
    () => {
      const f = fixture();
      f.hooks.integrateStops = true;
      return withService(f.layer, function* (service) {
        const writer = yield* completedWriter(service, f);
        const id = writer.workspaceId!;
        const tested = yield* reviewAndPrepare(service, id);
        yield* service.workspaceApply(id, { revisionId: tested.revisionId }).pipe(Effect.flip);
        expect(f.entries.get(id)?.status).toBe("integrating");
        expect(f.released).toContain("/repo");
        expect(yield* service.resume(writer.id).pipe(Effect.flip)).toMatchObject({
          code: "workspace_finished",
        });
        expect(
          yield* service.workspaceApply(id, { revisionId: tested.revisionId }).pipe(Effect.flip),
        ).toMatchObject({ code: "workspace_finished" });
        // Only this workspace is stuck: other worktree writers still start.
        expect((yield* stoppedWriter(service)).workspaceId).toBeDefined();
        yield* service.workspaceDiscard(id);
        expect(f.entries.get(id)?.status).toBe("discarded");
      });
    },
  );

  it.effect(
    "rolls a stopped integration back only while no shared-checkout writer edits the checkout",
    () => {
      // Directories whose writer-pool lease another session's shared-checkout writer holds.
      const held = new Set<string>();
      const f = fixture({ writerLeases: leasesWith(heldElsewhere((cwd) => held.has(cwd))) });
      f.hooks.integrateStops = true;
      return withService(f.layer, function* (service) {
        const id = (yield* stoppedWriter(service)).workspaceId!;
        const tested = yield* reviewAndPrepare(service, id);
        yield* service.workspaceApply(id, { revisionId: tested.revisionId }).pipe(Effect.flip);
        expect(f.entries.get(id)?.status).toBe("integrating");

        const writer = yield* service.start(sharedWriter({ cwd: "/repo/packages/a" }));
        expect(yield* service.workspaceDiscard(id).pipe(Effect.flip)).toMatchObject({
          code: "workspace_target_busy",
        });
        yield* service.stop(writer.id);
        held.add("/repo");
        expect(yield* service.workspaceDiscard(id).pipe(Effect.flip)).toMatchObject({
          code: "workspace_target_busy",
        });
        expect(f.entries.get(id)?.status).toBe("integrating");
        expect(f.rollbacks).toEqual([]);

        held.delete("/repo");
        yield* service.workspaceDiscard(id);
        expect(f.rollbacks).toEqual([id]);
        expect(f.entries.get(id)?.status).toBe("discarded");
      });
    },
  );

  it.effect("pages a review without splitting a character", () => {
    const f = fixture();
    // The review text leads with the revision's summary, which doesn't depend on its id.
    const summary = revisionSummary({ revisionId: "", changedPaths: ["file.ts"], diff: "" });
    const diff = `${Fn.pipe("x", Str.repeat(15_999 - summary.length))}\u{1F600}${Fn.pipe("y", Str.repeat(10))}`;
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

  it.effect("keeps a committed integration when a source lease release fails", () => {
    const f = fixture({ writerLeases: leasesWith(failingRelease("/repo")) });
    return withService(f.layer, function* (service) {
      const id = (yield* stoppedWriter(service)).workspaceId!;
      const other = (yield* stoppedWriter(service)).workspaceId!;
      const tested = yield* reviewAndPrepare(service, id);
      const outcome = yield* service.workspaceApply(id, { revisionId: tested.revisionId });
      expect(f.entries.get(id)?.status).toBe("integrated");
      expect(outcome).toMatchObject({ testing: "parent-tested", leaseReleaseUnconfirmed: true });
      expect(yield* service.start(repoWriter()).pipe(Effect.flip)).toMatchObject({
        code: "workspace_integration_quarantined",
      });
      expect(yield* service.workspaceApply(other).pipe(Effect.flip)).toMatchObject({
        code: "workspace_integration_quarantined",
      });
    });
  });

  it.effect("starts a worktree writer's own writers in its worker tree, never in worktrees", () => {
    const f = fixture();
    return withService(f.layer, function* (service) {
      const parent = yield* service.start(repoWriter());
      const child = yield* service.startSessionOwnedFrom(
        parent.id,
        request({ cwd: parent.cwd, writeIntent: "writer" }),
      );
      expect(child).toMatchObject({ cwd: parent.cwd, writerWorkspaceMode: "shared-checkout" });
      expect(child.workspaceId).toBeUndefined();
      // A custom agent that asks for a worktree must come from the root.
      expect(
        yield* service
          .startSessionOwnedFrom(
            parent.id,
            request({
              cwd: parent.cwd,
              writeIntent: "writer",
              writerWorkspaceModeOverride: "worktree",
            }),
          )
          .pipe(Effect.flip),
      ).toMatchObject({ code: "workspace_nested_writer_unsupported" });
      expect([...f.entries.keys()]).toEqual([parent.workspaceId]);
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
      expect(yield* runView(service, writer.id)).toMatchObject({
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
      const integrate = service.workspaceApply(id, { revisionId: tested.revisionId });
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
