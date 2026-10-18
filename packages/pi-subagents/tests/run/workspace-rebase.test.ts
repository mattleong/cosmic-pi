import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { WorkspaceError } from "../../src/workspace/model.ts";
import { request, withService } from "./fixtures/service-harness.ts";
import { reviewAndPrepare, stoppedWriter, workspaceFixture } from "./fixtures/workspace-engine.ts";

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
