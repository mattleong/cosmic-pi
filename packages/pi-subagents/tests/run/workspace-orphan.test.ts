import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { WorkspaceLaunch, WorkspaceRecord } from "../../src/workspace/model.ts";
import { withService } from "./fixtures/service-harness.ts";
import {
  leasesWith,
  repoWriter,
  workspaceFixture as fixture,
} from "./fixtures/workspace-engine.ts";

const ORPHAN_DIGEST = "f".repeat(64);

// The worker tree an orphan saved keeps the digest its creating session saw.
const orphanLeases = leasesWith((base) => ({
  canonicalize: (cwd) =>
    base
      .canonicalize(cwd)
      .pipe(
        Effect.map((identity) =>
          cwd.startsWith("/private/orphan/") ? { ...identity, digest: ORPHAN_DIGEST } : identity,
        ),
      ),
}));

const orphan = (
  workspaceId: string,
  status: WorkspaceRecord["status"],
  extra: Partial<WorkspaceRecord> = {},
  sourceWorkspaceId?: string,
): WorkspaceRecord => ({
  version: 2,
  repository: "/repo/.git",
  handle: {
    workspaceId,
    ownerId: "old-session/root",
    sourceRoot: sourceWorkspaceId === undefined ? "/repo" : `/private/${sourceWorkspaceId}/worker`,
    sourceCwd: sourceWorkspaceId === undefined ? "/repo" : `/private/${sourceWorkspaceId}/worker`,
    artifactRoot: `/private/${workspaceId}`,
    cwd: `/private/${workspaceId}/worker`,
    writerCwd: {
      path: `/private/${workspaceId}/worker`,
      filesystemIdentity: `dev:1;ino:/private/${workspaceId}/worker`,
      digest: ORPHAN_DIGEST,
    },
    ...(sourceWorkspaceId !== undefined && { sourceWorkspaceId, checkoutRoot: "/repo" }),
  },
  status,
  baseline: "baseline",
  ownerLease: "ended-owner",
  lastChangedAt: 0,
  ...extra,
});

describe("orphaned workspace takeover", () => {
  it.effect("marks which orphans of ended sessions the root may adopt", () => {
    const f = fixture();
    f.hooks.orphanOwnerEnded = true;
    f.entries.set("open", orphan("open", "frozen"));
    f.entries.set("parent", orphan("parent", "active"));
    f.entries.set("nested", orphan("nested", "active", {}, "parent"));
    f.entries.set("integrating", orphan("integrating", "integrating"));
    f.entries.set("done", orphan("done", "integrated"));
    return withService(f.layer, function* (service) {
      const own = yield* service.start(repoWriter());
      const { orphans } = yield* service.workspaceList();
      expect(Object.fromEntries(orphans ?? [])).toEqual({
        open: "adoptable",
        nested: "discard-only",
        integrating: "discard-only",
      });
      expect(orphans?.has(own.workspaceId ?? "")).toBe(false);
    });
  });

  it.effect("records the profile or custom agent a worktree writer was launched as", () => {
    const f = fixture();
    return withService(f.layer, function* (service) {
      const run = yield* service.start(
        repoWriter({ profile: "worker", agent: "auth-fixer", name: "fixer" }),
      );
      expect(f.entries.get(run.workspaceId ?? "")?.launch).toEqual({
        profile: "worker",
        agent: "auth-fixer",
        name: "fixer",
      });
    });
  });

  it.effect("revises an adopted workspace as a new run of its recorded launch", () => {
    const f = fixture({ writerLeases: orphanLeases });
    f.hooks.orphanOwnerEnded = true;
    f.entries.set(
      "orphan",
      orphan("orphan", "frozen", {
        revision: { revisionId: "old-revision", changedPaths: ["file.ts"] },
        launch: { profile: "worker", name: "fixer" },
      }),
    );
    const resolved: WorkspaceLaunch[] = [];
    const resolveLaunch = (launch: WorkspaceLaunch, task: string) =>
      Effect.sync(() => {
        resolved.push(launch);
        return repoWriter({
          profile: launch.profile === "worker" ? "worker" : undefined,
          name: launch.name,
          task,
        });
      });
    return withService(f.layer, function* (service) {
      expect(
        yield* service.workspaceRevise("orphan", "Fix the failing test").pipe(Effect.flip),
      ).toMatchObject({ code: "workspace_launch_unavailable" });
      expect(
        yield* service
          .workspaceRevise("orphan", "Fix the failing test", undefined, {
            resolveLaunch: (launch, task) =>
              resolveLaunch(launch, task).pipe(
                Effect.map((request) => ({ ...request, writeIntent: "read-only" as const })),
              ),
          })
          .pipe(Effect.flip),
      ).toMatchObject({ code: "workspace_launch_unavailable" });
      const { run } = yield* service.workspaceRevise("orphan", "Fix the failing test", undefined, {
        resolveLaunch,
      });
      expect(resolved.at(-1)).toEqual({ profile: "worker", name: "fixer" });
      expect(run).toMatchObject({
        workspaceId: "orphan",
        cwd: "/private/orphan/worker",
        profile: "worker",
        task: "Fix the failing test",
        writerWorkspaceMode: "worktree",
      });
      expect(f.entries.get("orphan")?.handle.ownerId).toBe("session-1/root");
      // The successor owns the workspace now: it refuses review until it stops.
      expect(yield* service.workspaceReview("orphan").pipe(Effect.flip)).toMatchObject({
        code: "workspace_process_unsettled",
      });
      yield* service.stop(run.id);
      expect((yield* service.workspaceReview("orphan")).revisionId).not.toBe("old-revision");
      // Later revisions extend the successor's request without resolving the launch again.
      const before = resolved.length;
      const { run: next } = yield* service.workspaceRevise("orphan", "Also update docs");
      expect(resolved).toHaveLength(before);
      expect(next.task).toContain("Also update docs");
    });
  });
});
