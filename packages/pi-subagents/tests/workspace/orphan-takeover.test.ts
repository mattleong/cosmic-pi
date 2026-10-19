import { expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { nodeFilePlatformLayer, SafeFile } from "pi-cosmic-core";
import * as files from "../../src/boundary/git-worktree-publish.ts";
import { readWorkspaceRecord } from "../../src/boundary/git-worktree-store.ts";
import { nodeFsPromises as fs, nodePath as path } from "../../src/boundary/node-builtins.ts";
import { WriterLeaseService } from "../../src/boundary/writer-lease.ts";
import { workspaceControl } from "../../src/run/workspace-control.ts";
import {
  type WorkspaceHandle,
  type WorkspaceRecord,
  WorkspaceRecordSchema,
} from "../../src/workspace/model.ts";
import type { WorkspaceServiceContract } from "../../src/workspace/service.ts";
import {
  commitRepository,
  exists,
  failureOf,
  io,
  openWorkspaceService,
  readText,
  registryOf,
  temporaryDirectory,
  workspaceTarget,
  writeFile,
} from "./fixtures/repository.ts";

const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(WorkspaceRecordSchema));

/** A checkout with a session that created workspaces in it and then ended. */
const orphanScenario = (prefix: string) =>
  Effect.gen(function* () {
    const temporary = yield* temporaryDirectory(prefix);
    const source = path.join(temporary, "source");
    const agent = path.join(temporary, "agent");
    yield* io(() => fs.mkdir(agent, { mode: 0o700 }));
    yield* commitRepository(source, [
      ["src/main.ts", "baseline\n"],
      ["other.txt", "other\n"],
    ]);
    const creator = yield* openWorkspaceService(agent);
    return { source, agent, creator };
  });

/** The root coordinator of a later session sharing the agent directory. */
const laterSession = (agent: string, source: string) =>
  Effect.gen(function* () {
    const successor = yield* openWorkspaceService(agent);
    const leases = yield* WriterLeaseService.pipe(
      Effect.provide(WriterLeaseService.layer({ agentDirectory: agent })),
    );
    const control = workspaceControl({
      ownerScope: yield* Scope.Scope,
      records: new Map(),
      withLock: (effect) => effect,
      writerLeases: leases,
      engine: successor.service,
      initialMode: "worktree",
      worktreeCreate: [],
      ownerId: "new",
      sourceCwd: source,
      isClosed: () => false,
      publish: Effect.void,
    });
    return { control, leases, successor };
  });

/** Reads every review page, as the careful path requires before prepare. */
const reviewAll = (control: ReturnType<typeof workspaceControl>, workspaceId: string) =>
  Effect.gen(function* () {
    let page = yield* control.workspaceReview(workspaceId);
    while (page.nextOffset !== undefined)
      page = yield* control.workspaceReview(workspaceId, {
        revisionId: page.revisionId,
        offset: page.nextOffset,
      });
    return page.revisionId;
  });

const neverStarts = () => Effect.die("A discard-only orphan never launches a successor.");

const nested = (service: WorkspaceServiceContract, parent: WorkspaceHandle) =>
  service.create({
    sourceCwd: parent.cwd,
    ownerId: "old/child",
    sourceWorkspace: { workspaceId: parent.workspaceId, ownerId: parent.ownerId },
  });

const savedRecord = (agent: string, workspaceId: string) =>
  readWorkspaceRecord(registryOf(agent), workspaceId).pipe(
    Effect.provide(SafeFile.layer.pipe(Layer.provide(nodeFilePlatformLayer))),
  );

/** Makes a record look last changed `days` ago. */
const ageRecord = (agent: string, workspaceId: string, days: number) =>
  Effect.gen(function* () {
    const record = yield* savedRecord(agent, workspaceId);
    const changedAt = (yield* Clock.currentTimeMillis) - Duration.toMillis(Duration.days(days));
    const aged: WorkspaceRecord = { ...record, lastChangedAt: changedAt };
    const text = yield* encodeRecord(aged);
    yield* io(() => fs.writeFile(path.join(registryOf(agent), workspaceId, "record.json"), text));
  });

// Publication stops at src/main.ts because an editor saved it after the preimage check, so
// other.txt is already published with its original in a backup.
const originalPublish = files.publishWorkspaceFile;
const stopPublicationAtMain = (
  service: WorkspaceServiceContract,
  handle: WorkspaceHandle,
  root: string,
) =>
  Effect.gen(function* () {
    yield* writeFile(path.join(handle.cwd, "other.txt"), "published first\n");
    yield* writeFile(path.join(handle.cwd, "src/main.ts"), "never published\n");
    const revision = yield* service.freeze(workspaceTarget(handle));
    const prepared = yield* service.prepare({
      ...workspaceTarget(handle),
      revisionId: revision.revisionId,
    });
    const spy = vi.spyOn(files, "publishWorkspaceFile").mockImplementation((request, hooks) =>
      Effect.gen(function* () {
        if (request.name === "main.ts")
          yield* writeFile(path.join(request.directory, request.name), "editor save\n");
        return yield* originalPublish(request, hooks);
      }).pipe(Effect.orDie),
    );
    yield* failureOf(
      service.integrate({
        ...workspaceTarget(handle),
        revisionId: revision.revisionId,
        preparationId: prepared.preparationId,
      }),
    ).pipe(Effect.ensuring(Effect.sync(() => spy.mockRestore())));
    expect(yield* readText(root, "other.txt")).toBe("published first\n");
  });

it.live(
  "adopts an ended session's workspace on review, then prepares and applies it",
  () =>
    Effect.gen(function* () {
      const { source, agent, creator } = yield* orphanScenario("pi-adopt-");
      const handle = yield* creator.service.create({ sourceCwd: source, ownerId: "old/root" });
      yield* writeFile(path.join(handle.cwd, "src/main.ts"), "adopted change\n");
      const { control, successor } = yield* laterSession(agent, source);
      // A live owner refuses takeover and keeps the workspace as it is.
      expect(yield* control.workspaceReview(handle.workspaceId).pipe(Effect.flip)).toMatchObject({
        code: "workspace_owner_unavailable",
      });
      expect((yield* control.workspaceList()).orphans).toBeUndefined();
      yield* creator.close;
      expect((yield* control.workspaceList()).orphans?.get(handle.workspaceId)).toBe("adoptable");

      const revisionId = yield* reviewAll(control, handle.workspaceId);
      expect((yield* control.workspaceList()).orphans).toBeUndefined();
      const prepared = yield* control.workspacePrepare(handle.workspaceId, revisionId);
      yield* control.workspaceApply(handle.workspaceId, {
        revisionId,
        preparationId: prepared.preparationId,
      });
      expect(yield* readText(source, "src/main.ts")).toBe("adopted change\n");
      expect(yield* exists(handle.cwd)).toBe(false);
      const [record] = (yield* successor.service.listAll).records;
      expect(record?.status).toBe("integrated");
      expect(record?.handle.ownerId).toBe("new/root");
      yield* successor.close;
    }).pipe(Effect.scoped),
  60_000,
);

it.live(
  "refuses takeover while a writer holds the worker tree or children are unresolved",
  () =>
    Effect.gen(function* () {
      const { source, agent, creator } = yield* orphanScenario("pi-adopt-refusals-");
      const parent = yield* creator.service.create({ sourceCwd: source, ownerId: "old/root" });
      const child = yield* nested(creator.service, parent);
      const held = yield* creator.service.create({ sourceCwd: source, ownerId: "old/root" });
      yield* creator.close;
      const { control, leases, successor } = yield* laterSession(agent, source);
      const lease = yield* leases.acquire({
        cwd: yield* leases.canonicalize(held.cwd),
        runId: "live-writer",
      });
      expect(yield* control.workspaceReview(held.workspaceId).pipe(Effect.flip)).toMatchObject({
        code: "workspace_process_unsettled",
      });
      yield* leases.release(lease);

      const orphans = (yield* control.workspaceList()).orphans;
      expect(orphans?.get(child.workspaceId)).toBe("discard-only");
      expect(orphans?.has(parent.workspaceId)).toBe(false);
      expect(yield* control.workspaceReview(parent.workspaceId).pipe(Effect.flip)).toMatchObject({
        code: "workspace_children_unresolved",
      });
      // A nested orphan can only be discarded; then its source workspace can be adopted.
      expect(yield* control.workspaceReview(child.workspaceId).pipe(Effect.flip)).toMatchObject({
        code: "workspace_orphan_discard_only",
      });
      expect(
        yield* control.revise(neverStarts)(child.workspaceId, "Continue").pipe(Effect.flip),
      ).toMatchObject({ code: "workspace_orphan_discard_only" });
      yield* control.workspaceDiscard(child.workspaceId);
      expect((yield* control.workspaceReview(parent.workspaceId)).changedPaths).toEqual([]);
      yield* successor.close;
    }).pipe(Effect.scoped),
  60_000,
);

it.live(
  "rolls back a mid-integration orphan once it holds fresh source leases",
  () =>
    Effect.gen(function* () {
      const { source, agent, creator } = yield* orphanScenario("pi-orphan-rollback-");
      const handle = yield* creator.service.create({ sourceCwd: source, ownerId: "old/root" });
      yield* stopPublicationAtMain(creator.service, handle, source);
      yield* creator.close;
      const { control, leases, successor } = yield* laterSession(agent, source);
      expect((yield* control.workspaceList()).orphans?.get(handle.workspaceId)).toBe(
        "discard-only",
      );
      expect(yield* control.workspaceReview(handle.workspaceId).pipe(Effect.flip)).toMatchObject({
        code: "workspace_orphan_discard_only",
      });
      // A writer in the checkout keeps the half-published files as they are.
      const writer = yield* leases.acquire({
        cwd: yield* leases.canonicalize(source),
        runId: "checkout-writer",
      });
      expect(yield* control.workspaceDiscard(handle.workspaceId).pipe(Effect.flip)).toMatchObject({
        code: "workspace_target_busy",
      });
      expect(yield* readText(source, "other.txt")).toBe("published first\n");
      yield* leases.release(writer);

      yield* control.workspaceDiscard(handle.workspaceId);
      expect(yield* readText(source, "other.txt")).toBe("other\n");
      expect(yield* readText(source, "src/main.ts")).toBe("editor save\n");
      expect(yield* exists(handle.cwd)).toBe(false);
      expect((yield* successor.service.listAll).records[0]?.status).toBe("discarded");
      // The rollback released its source leases.
      yield* leases.release(
        yield* leases.acquire({ cwd: yield* leases.canonicalize(source), runId: "after" }),
      );
      yield* successor.close;
    }).pipe(Effect.scoped),
  60_000,
);

it.live(
  "sweeps month-old orphans, children first, keeping each patch and skipping the rest",
  () =>
    Effect.gen(function* () {
      const { source, agent, creator } = yield* orphanScenario("pi-orphan-sweep-");
      const create = creator.service.create({ sourceCwd: source, ownerId: "old/root" });
      const old = yield* create;
      yield* writeFile(path.join(old.cwd, "src/main.ts"), "month-old work\n");
      const young = yield* create;
      const integrating = yield* create;
      yield* stopPublicationAtMain(creator.service, integrating, source);
      const busyParent = yield* create;
      const youngChild = yield* nested(creator.service, busyParent);
      const chainParent = yield* create;
      const chainChild = yield* nested(creator.service, chainParent);
      yield* creator.close;
      for (const handle of [old, integrating, busyParent, chainParent, chainChild])
        yield* ageRecord(agent, handle.workspaceId, 31);
      yield* ageRecord(agent, young.workspaceId, 29);
      yield* ageRecord(agent, youngChild.workspaceId, 1);

      const { control, successor } = yield* laterSession(agent, source);
      const swept = yield* control.sweepOrphanedWorkspaces;
      expect(swept.map((entry) => entry.workspaceId)).toEqual([
        expect.any(String),
        expect.any(String),
        expect.any(String),
      ]);
      expect(new Set(swept.map((entry) => entry.workspaceId))).toEqual(
        new Set([old.workspaceId, chainParent.workspaceId, chainChild.workspaceId]),
      );
      // The child goes before the parent it was created from.
      expect(swept.findIndex((entry) => entry.workspaceId === chainChild.workspaceId)).toBeLessThan(
        swept.findIndex((entry) => entry.workspaceId === chainParent.workspaceId),
      );
      const oldSwept = swept.find((entry) => entry.workspaceId === old.workspaceId);
      expect(oldSwept?.changedPathCount).toBe(1);
      expect(yield* readText(oldSwept?.patchPath ?? "")).toContain("+month-old work");
      expect(yield* exists(old.cwd)).toBe(false);
      const record = yield* savedRecord(agent, old.workspaceId);
      expect(record).toMatchObject({ status: "discarded", disposition: "orphan-swept" });

      for (const kept of [young, integrating, busyParent, youngChild])
        expect(yield* exists(kept.cwd)).toBe(true);
      expect((yield* savedRecord(agent, integrating.workspaceId)).status).toBe("integrating");
      expect(yield* control.sweepOrphanedWorkspaces).toEqual([]);
      yield* successor.close;
    }).pipe(Effect.scoped),
  90_000,
);

it.live(
  "sweeps only the session's own checkout",
  () =>
    Effect.gen(function* () {
      const { source, agent, creator } = yield* orphanScenario("pi-orphan-sweep-scope-");
      const other = path.join(path.dirname(source), "other");
      yield* commitRepository(other, [["main.ts", "other\n"]]);
      const own = yield* creator.service.create({ sourceCwd: source, ownerId: "old/root" });
      const foreign = yield* creator.service.create({ sourceCwd: other, ownerId: "old/root" });
      yield* creator.close;
      for (const handle of [own, foreign]) yield* ageRecord(agent, handle.workspaceId, 31);

      const { control, successor } = yield* laterSession(agent, source);
      const swept = yield* control.sweepOrphanedWorkspaces;
      expect(swept.map((entry) => entry.workspaceId)).toEqual([own.workspaceId]);
      expect(yield* exists(foreign.cwd)).toBe(true);
      expect((yield* savedRecord(agent, foreign.workspaceId)).status).toBe("active");
      yield* successor.close;
    }).pipe(Effect.scoped),
  60_000,
);
