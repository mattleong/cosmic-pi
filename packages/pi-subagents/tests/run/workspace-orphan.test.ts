import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { WorkspaceLaunch, WorkspaceRecord } from "../../src/workspace/model.ts";
import { workspaceRecord } from "../fixtures/workspace-record.ts";
import { fakeWriterLeaseLayer, withService } from "./fixtures/service-harness.ts";
import {
  heldElsewhere,
  type LeaseOverride,
  leasesWith,
  repoWriter,
  workspaceFixture as fixture,
} from "./fixtures/workspace-engine.ts";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import * as Rec from "effect/Record";

const ORPHAN_DIGEST = Fn.pipe("f", Str.repeat(64));

// The worker tree an orphan saved keeps the digest its creating session saw.
const orphanCanonicalize: LeaseOverride = (base) => ({
  canonicalize: (cwd) =>
    base
      .canonicalize(cwd)
      .pipe(
        Effect.map((identity) =>
          Fn.pipe(cwd, Str.startsWith("/private/orphan/"))
            ? { ...identity, digest: ORPHAN_DIGEST }
            : identity,
        ),
      ),
});

const orphan = (
  workspaceId: string,
  status: WorkspaceRecord["status"],
  extra: Partial<Omit<WorkspaceRecord, "handle">> = {},
): WorkspaceRecord =>
  workspaceRecord(workspaceId, {
    handle: {
      ownerId: "old-session/root",
      sourceRoot: "/repo",
      sourceCwd: "/repo",
      artifactRoot: `/private/${workspaceId}`,
      cwd: `/private/${workspaceId}/worker`,
      writerCwd: {
        path: `/private/${workspaceId}/worker`,
        filesystemIdentity: `dev:1;ino:/private/${workspaceId}/worker`,
        digest: ORPHAN_DIGEST,
      },
    },
    status,
    ...extra,
  });

describe("orphaned workspace takeover", () => {
  it.effect("marks which orphans of ended sessions the root may adopt", () => {
    const f = fixture();
    f.hooks.orphanOwnerEnded = true;
    f.entries.set("open", orphan("open", "frozen"));
    f.entries.set("integrating", orphan("integrating", "integrating"));
    f.entries.set("done", orphan("done", "integrated"));
    return withService(f.layer, function* (service) {
      const own = yield* service.start(repoWriter());
      const { orphans } = yield* service.workspaceList();
      expect(Rec.fromEntries(orphans ?? [])).toEqual({
        open: "adoptable",
        integrating: "discard-only",
      });
      expect(orphans?.has(own.workspaceId ?? "")).toBe(false);
    });
  });

  it.effect("refuses orphan discard without original directory identity", () => {
    const f = fixture();
    f.hooks.orphanOwnerEnded = true;
    const original = orphan("unready", "active");
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

  it.effect("keeps an orphan while a writer still holds its worker tree", () => {
    const f = fixture({ writerLeases: fakeWriterLeaseLayer({ failAcquire: true }) });
    f.hooks.orphanOwnerEnded = true;
    f.entries.set("orphan", orphan("orphan", "active"));
    return withService(f.layer, function* (service) {
      expect(yield* service.workspaceDiscard("orphan").pipe(Effect.flip)).toMatchObject({
        code: "workspace_process_unsettled",
      });
      expect(f.entries.get("orphan")?.status).toBe("active");
    });
  });

  it.effect("rolls a mid-integration orphan back only while no writer holds the checkout", () => {
    let held = true;
    const f = fixture({
      writerLeases: leasesWith((base) => ({
        ...orphanCanonicalize(base),
        ...heldElsewhere((cwd) => held && cwd === "/repo")(base),
      })),
    });
    f.hooks.orphanOwnerEnded = true;
    f.entries.set("orphan", orphan("orphan", "integrating"));
    return withService(f.layer, function* (service) {
      expect(yield* service.workspaceDiscard("orphan").pipe(Effect.flip)).toMatchObject({
        code: "workspace_target_busy",
      });
      expect(f.entries.get("orphan")?.status).toBe("integrating");
      held = false;
      yield* service.workspaceDiscard("orphan");
      expect(f.rollbacks).toEqual(["orphan"]);
      expect(f.entries.get("orphan")?.status).toBe("discarded");
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
    const f = fixture({ writerLeases: leasesWith(orphanCanonicalize) });
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
