import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { WorkspaceError } from "../../src/workspace/model.ts";
import { request, withService } from "./fixtures/service-harness.ts";
import { reviewAndPrepare, stoppedWriter, workspaceFixture } from "./fixtures/workspace-engine.ts";

describe("rebasing revise", () => {
  it.effect(
    "rebuilds the tree, runs WorktreeCreate there, and lists conflicts in the successor's task",
    () => {
      const f = workspaceFixture({ worktreeCreate: [{ command: ["pnpm", "install"] }] });
      return withService(f.layer, function* (service) {
        const writer = yield* stoppedWriter(service);
        const id = writer.workspaceId!;
        yield* reviewAndPrepare(service, id);
        f.hooks.rebase = { reappliedPaths: ["file.ts", "b.ts"], conflictedPaths: ["file.ts"] };
        const hookRunsBefore = f.hookRuns.length;
        const revised = yield* service.workspaceRevise(id, "Use the new API.", undefined, {
          rebase: true,
        });
        expect(revised.rebase).toEqual({
          reappliedPaths: ["file.ts", "b.ts"],
          conflictedPaths: ["file.ts"],
        });
        expect(f.rebases).toEqual([id]);
        expect(f.hookRuns.slice(hookRunsBefore)).toEqual([{ tree: "worker", runId: writer.id }]);
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
      f.hooks.rebase = WorkspaceError.make({
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
      expect(applied.testing).toBe("parent-tested");
    });
  });
});
