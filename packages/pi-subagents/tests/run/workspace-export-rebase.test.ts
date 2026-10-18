import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { WorkspaceError, type WorkspaceRecord } from "../../src/workspace/model.ts";
import { request, withService } from "./fixtures/service-harness.ts";
import { reviewAndPrepare, stoppedWriter, workspaceFixture } from "./fixtures/workspace-engine.ts";

const orphanRecord = (workspaceId: string): WorkspaceRecord => ({
  version: 1,
  handle: {
    workspaceId,
    ownerId: "ended-session/root",
    sourceRoot: "/repo",
    sourceCwd: "/repo",
    cwd: `/private/${workspaceId}`,
    writerCwd: {
      path: `/private/${workspaceId}`,
      filesystemIdentity: `dev:1;ino:/private/${workspaceId}`,
      digest: "1".padStart(64, "0"),
    },
  },
  status: "active",
  baseline: "baseline",
});

describe("workspace export", () => {
  it.effect("exports the current revision for its direct parent and keeps the proposal", () => {
    const f = workspaceFixture();
    return withService(f.layer, function* (service) {
      const id = (yield* stoppedWriter(service, { name: "Token parser" })).workspaceId!;
      const patch = yield* service.workspaceExport(id);
      expect(patch).toMatchObject({ format: "patch", orphan: false, changedPaths: ["file.ts"] });
      // Export froze the workspace like review, and the proposal is still applicable.
      expect(f.entries.get(id)).toMatchObject({
        status: "frozen",
        revision: { revisionId: patch.revisionId },
      });
      const branch = yield* service.workspaceExport(id, {
        revisionId: patch.revisionId,
        format: "branch",
      });
      expect(branch).toMatchObject({ format: "branch", branch: "pi-subagent/token-parser" });
      expect(f.exports).toEqual([
        { workspaceId: id, request: { format: "patch" } },
        { workspaceId: id, request: { format: "branch", branch: "pi-subagent/token-parser" } },
      ]);
      expect(
        yield* service.workspaceExport(id, { revisionId: "revision-9" }).pipe(Effect.flip),
      ).toMatchObject({ code: "workspace_revision_stale" });
      const applied = yield* service.workspaceApply(id, { revisionId: patch.revisionId });
      expect(applied.integrated).toBe(true);
      expect(yield* service.workspaceExport(id).pipe(Effect.flip)).toMatchObject({
        code: "workspace_finished",
      });
    });
  });

  it.effect("lets the root export an orphan only once its session ended, read-only", () => {
    const f = workspaceFixture();
    f.entries.set("orphan", orphanRecord("orphan"));
    return withService(f.layer, function* (service) {
      expect(yield* service.workspaceExport("orphan").pipe(Effect.flip)).toMatchObject({
        code: "workspace_owner_unavailable",
      });
      f.hooks.orphanOwnerEnded = true;
      const exported = yield* service.workspaceExport("orphan");
      expect(exported).toMatchObject({ orphan: true, format: "patch" });
      expect(f.entries.get("orphan")?.status).toBe("active");
      // Like orphan discard, export first proves no writer holds the worker tree.
      expect(f.acquired).toContain("/private/orphan");
      expect(f.released).toContain("/private/orphan");
      const writer = yield* stoppedWriter(service);
      expect(
        yield* service.workspaceExport("orphan", undefined, writer.id).pipe(Effect.flip),
      ).toMatchObject({ code: "workspace_owner_unavailable" });
    });
  });
});

describe("partial apply", () => {
  it.effect("integrates the chosen paths and keeps the rest as an unreviewed proposal", () => {
    const f = workspaceFixture();
    f.hooks.changedPaths = ["a.ts", "b.ts", "c.ts"];
    return withService(f.layer, function* (service) {
      const id = (yield* stoppedWriter(service)).workspaceId!;
      expect(
        yield* service.workspaceApply(id, { paths: ["b.ts", "missing.ts"] }).pipe(Effect.flip),
      ).toMatchObject({ code: "workspace_paths_unknown" });
      expect(f.entries.get(id)?.preparation).toBeUndefined();
      const partial = yield* service.workspaceApply(id, { paths: ["c.ts", "a.ts"] });
      expect(partial).toMatchObject({
        integrated: true,
        changedPaths: ["a.ts", "c.ts"],
        changedPathCount: 2,
        remainingPaths: ["b.ts"],
        remainingPathCount: 1,
      });
      expect(f.integrations).toHaveLength(1);
      expect(f.entries.get(id)?.status).toBe("active");
      // The prepared pair was partial; a careful-path apply of it is now stale.
      expect(
        yield* service
          .workspaceApply(id, {
            revisionId: partial.revisionId,
            preparationId: partial.preparationId,
          })
          .pipe(Effect.flip),
      ).toMatchObject({ code: "workspace_preparation_stale" });
      f.hooks.changedPaths = ["b.ts"];
      const rest = yield* service.workspaceApply(id);
      expect(rest).toMatchObject({ integrated: true, changedPaths: ["b.ts"] });
      expect(rest.remainingPaths).toBeUndefined();
      expect(rest.revisionId).not.toBe(partial.revisionId);
      expect(f.entries.get(id)?.status).toBe("integrated");
    });
  });

  it.effect("naming every changed path applies the whole revision", () => {
    const f = workspaceFixture();
    f.hooks.changedPaths = ["a.ts", "b.ts"];
    return withService(f.layer, function* (service) {
      const id = (yield* stoppedWriter(service)).workspaceId!;
      const applied = yield* service.workspaceApply(id, { paths: ["b.ts", "a.ts"] });
      expect(applied.remainingPathCount).toBeUndefined();
      expect(f.entries.get(id)?.status).toBe("integrated");
    });
  });
});

describe("rebasing revise", () => {
  it.effect(
    "rebuilds the tree, runs setup there, and lists conflicts in the successor's task",
    () => {
      const f = workspaceFixture({ workspaceSetup: { command: ["pnpm", "install"] } });
      return withService(f.layer, function* (service) {
        const writer = yield* stoppedWriter(service);
        const id = writer.workspaceId!;
        yield* reviewAndPrepare(service, id);
        f.hooks.rebase = { reappliedPaths: ["file.ts", "b.ts"], conflictedPaths: ["file.ts"] };
        const setupsBefore = f.setups.length;
        const revised = yield* service.workspaceRevise(id, "Use the new API.", undefined, {
          rebase: true,
        });
        expect(revised.rebase).toEqual({
          reappliedPaths: ["file.ts", "b.ts"],
          conflictedPaths: ["file.ts"],
        });
        expect(f.rebases).toEqual([id]);
        expect(f.setups.slice(setupsBefore)).toEqual(["worker"]);
        expect(revised.run.task).toContain("Use the new API.");
        expect(revised.run.task).toContain("Parent rebase:");
        expect(revised.run.task).toContain('"file.ts"');
        yield* service.stop(revised.run.id);
        // The note goes only to the rebased successor; a later revision extends the plain task.
        const plain = yield* service.workspaceRevise(id, "Polish.");
        expect(plain.rebase).toBeUndefined();
        expect(plain.run.task).not.toContain("Parent rebase:");
        expect(plain.run.task).toContain("Use the new API.");
        expect(f.rebases).toEqual([id]);
      });
    },
  );

  it.effect("refuses to rebuild a tree a reader still uses", () => {
    const f = workspaceFixture();
    return withService(f.layer, function* (service) {
      const writer = yield* stoppedWriter(service);
      yield* service.start(request({ cwd: writer.cwd }));
      expect(
        yield* service
          .workspaceRevise(writer.workspaceId!, "Rebase it.", undefined, { rebase: true })
          .pipe(Effect.flip),
      ).toMatchObject({ code: "workspace_process_unsettled" });
      expect(f.rebases).toEqual([]);
    });
  });

  it.effect("a refused rebase starts nothing and leaves the reviewed revision usable", () => {
    const f = workspaceFixture();
    return withService(f.layer, function* (service) {
      const writer = yield* stoppedWriter(service);
      const id = writer.workspaceId!;
      const tested = yield* reviewAndPrepare(service, id);
      f.hooks.rebase = new WorkspaceError({
        operation: "rebase",
        code: "workspace_rebase_refused",
        message: "The previous changes can't be reapplied to the parent's current files.",
      });
      const runsBefore = f.children.controls.length;
      expect(
        yield* service
          .workspaceRevise(id, "Rebase it.", undefined, { rebase: true })
          .pipe(Effect.flip),
      ).toMatchObject({ code: "workspace_rebase_refused" });
      expect(f.children.controls).toHaveLength(runsBefore);
      const applied = yield* service.workspaceApply(id, tested);
      expect(applied.integrated).toBe(true);
    });
  });
});
