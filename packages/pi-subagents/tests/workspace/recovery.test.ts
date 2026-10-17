import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { WriterLeaseService } from "../../src/boundary/writer-lease.ts";
import { workspaceControlContext } from "../../src/run/workspace-binding.ts";
import { workspaceOrphanOperations } from "../../src/run/workspace-orphan.ts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import { CrossProcessLock } from "pi-cosmic-core";
import {
  sourceLockNamespace,
  withFreeLock,
  workspaceLockDirectory,
} from "../../src/boundary/git-worktree-store.ts";
import { nodeFsPromises as fs, nodePath as path } from "../../src/boundary/node-builtins.ts";
import { WorkspaceService } from "../../src/workspace/service.ts";
import {
  commitRepository,
  exists,
  failureOf,
  io,
  openWorkspaceService,
  temporaryDirectory,
  workspaceTarget,
  workspaceTests,
  writeFile,
} from "./fixtures/repository.ts";

for (const replaced of [false, true]) {
  it.live(
    `retains a ${replaced ? "replaced" : "renamed"} worker cwd while its original lease is held`,
    () =>
      Effect.gen(function* () {
        const temporary = yield* temporaryDirectory("pi-orphan-identity-");
        const source = path.join(temporary, "source");
        const agent = path.join(temporary, "agent");
        yield* io(() => fs.mkdir(agent, { mode: 0o700 }));
        yield* commitRepository(source, [["pkg/main.ts", "baseline\n"]]);
        const creator = yield* openWorkspaceService(agent);
        const handle = yield* creator.service.create({
          sourceCwd: path.join(source, "pkg"),
          ownerId: "old/root",
        });
        const leases = yield* WriterLeaseService.pipe(
          Effect.provide(WriterLeaseService.layer({ agentDirectory: agent })),
        );
        const identity = yield* leases.canonicalize(handle.cwd);
        expect(handle.writerCwd).toEqual(identity);
        const lease = yield* Effect.acquireRelease(
          leases.acquire({ cwd: identity, runId: "live-writer" }),
          (held) => leases.release(held).pipe(Effect.orDie),
        );
        yield* leases.markSpawnStarted(lease);
        const renamed = `${handle.cwd}-renamed`;
        yield* io(() => fs.rename(handle.cwd, renamed));
        if (replaced) {
          yield* io(() => fs.mkdir(handle.cwd));
          yield* writeFile(path.join(handle.cwd, "replacement.ts"), "keep replacement\n");
          expect((yield* leases.canonicalize(handle.cwd)).digest).not.toBe(identity.digest);
        }
        yield* creator.close;
        const successor = yield* openWorkspaceService(agent);
        const context = workspaceControlContext({
          ownerScope: yield* Scope.Scope,
          records: new Map(),
          withLock: (effect) => effect,
          writerLeases: leases,
          engine: successor.service,
          initialMode: "worktree",
          ownerId: "new",
          sourceCwd: source,
          isClosed: () => false,
        });
        expect(
          yield* workspaceOrphanOperations(
            context,
            Effect.succeed,
          )(handle.workspaceId).pipe(Effect.flip),
        ).toMatchObject({ code: "workspace_process_unsettled" });
        expect(yield* exists(path.join(renamed, "main.ts"))).toBe(true);
        if (replaced) expect(yield* exists(path.join(handle.cwd, "replacement.ts"))).toBe(true);
        expect((yield* successor.service.listAll).records[0]?.status).toBe("active");
        yield* successor.close;
      }),
    60_000,
  );
}

it.live(
  "preserves both worker trees when its path is replaced while orphan discard waits for the source lock",
  () =>
    Effect.gen(function* () {
      const temporary = yield* temporaryDirectory("pi-orphan-cleanup-race-");
      const source = path.join(temporary, "source");
      const agent = path.join(temporary, "agent");
      yield* io(() => fs.mkdir(agent, { mode: 0o700 }));
      yield* commitRepository(source, [["main.ts", "baseline\n"]]);
      const creator = yield* openWorkspaceService(agent);
      const handle = yield* creator.service.create({ sourceCwd: source, ownerId: "old/root" });
      const target = workspaceTarget(handle);
      const revision = yield* creator.service.freeze(target);
      const preparation = yield* creator.service.prepare({
        ...target,
        revisionId: revision.revisionId,
      });
      yield* creator.close;
      const successor = yield* openWorkspaceService(agent);
      const registry = path.join(agent, "git-workspaces");
      const lockDirectory = workspaceLockDirectory(registry);
      const verified = yield* Deferred.make<void>();
      const leases = yield* WriterLeaseService.pipe(
        Effect.provide(WriterLeaseService.layer({ agentDirectory: agent })),
      );
      const context = workspaceControlContext({
        ownerScope: yield* Scope.Scope,
        records: new Map(),
        withLock: (effect) => effect,
        writerLeases: {
          ...leases,
          canonicalize: (cwd) =>
            leases.canonicalize(cwd).pipe(Effect.tap(() => Deferred.succeed(verified, undefined))),
        },
        engine: successor.service,
        initialMode: "worktree",
        ownerId: "new",
        sourceCwd: source,
        isClosed: () => false,
      });
      const renamed = `${handle.cwd}-original`;
      const pending = yield* Effect.gen(function* () {
        const locks = yield* CrossProcessLock;
        return yield* withFreeLock(
          locks,
          lockDirectory,
          sourceLockNamespace(source),
          Effect.gen(function* () {
            const discard = yield* workspaceOrphanOperations(
              context,
              Effect.succeed,
            )(handle.workspaceId).pipe(Effect.result, Effect.forkChild);
            yield* Deferred.await(verified);
            yield* io(() => fs.rename(handle.cwd, renamed));
            // Retain valid worktree metadata: Git would otherwise happily remove this copy.
            yield* io(() => fs.cp(renamed, handle.cwd, { recursive: true }));
            yield* writeFile(path.join(handle.cwd, "replacement.ts"), "preserve replacement\n");
            return discard;
          }),
        );
      }).pipe(Effect.provide(CrossProcessLock.layer({ directory: lockDirectory })));
      const outcome = yield* Fiber.join(Option.getOrThrow(pending));
      expect(outcome).toMatchObject({ failure: { code: "workspace_operation_failed" } });
      expect(yield* exists(path.join(renamed, "main.ts"))).toBe(true);
      expect(yield* exists(path.join(handle.cwd, "replacement.ts"))).toBe(true);
      expect(yield* exists(path.join(preparation.cwd, "main.ts"))).toBe(true);
      expect((yield* successor.service.listAll).records[0]?.status).toBe("prepared");
      yield* successor.close;
    }),
  60_000,
);

it.live(
  "discards an orphan only once the session that created it has ended",
  () =>
    Effect.gen(function* () {
      const temporary = yield* temporaryDirectory("pi-orphan-");
      const source = path.join(temporary, "source");
      const agent = path.join(temporary, "agent");
      yield* io(() => fs.mkdir(agent, { mode: 0o700 }));
      yield* commitRepository(source, [["main.ts", "baseline\n"]]);
      const creator = yield* openWorkspaceService(agent);
      const handle = yield* creator.service.create({ sourceCwd: source, ownerId: "old/root" });
      yield* writeFile(path.join(handle.cwd, "main.ts"), "unreviewed\n");
      const successor = yield* openWorkspaceService(agent);
      const target = { workspaceId: handle.workspaceId };
      expect((yield* failureOf(successor.service.discardOrphan(target))).operation).toBe(
        "authorization",
      );
      expect((yield* failureOf(creator.service.discardOrphan(target))).operation).toBe(
        "authorization",
      );
      expect(yield* exists(handle.cwd)).toBe(true);
      const revision = yield* creator.service.freeze(workspaceTarget(handle));
      const preparation = yield* creator.service.prepare({
        ...workspaceTarget(handle),
        revisionId: revision.revisionId,
      });
      yield* creator.close;
      yield* successor.service.discardOrphan(target);
      expect(yield* exists(handle.cwd)).toBe(false);
      expect(yield* exists(preparation.cwd)).toBe(false);
      expect((yield* successor.service.listAll).records.map((record) => record.status)).toEqual([
        "discarded",
      ]);
      yield* successor.close;
    }),
  60_000,
);

const test = workspaceTests([
  ["src/main.ts", "baseline\n"],
  [".gitignore", "ignored.ts\n"],
]);

const age = (agent: string, workspaceId: string, days: number) =>
  Effect.gen(function* () {
    const seconds = (yield* Clock.currentTimeMillis) / 1000 - days * 24 * 60 * 60;
    yield* io(() =>
      fs.utimes(path.join(agent, "git-workspaces", workspaceId, "record.json"), seconds, seconds),
    );
  });

test("collects week-old finished records but keeps unintegrated work and fork predecessors", function* (service, root, agent) {
  const expired = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* service.discard(workspaceTarget(expired));
  const recent = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* service.discard(workspaceTarget(recent));
  const kept = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* writeFile(path.join(kept.cwd, "src/main.ts"), "integrated\n");
  yield* writeFile(path.join(kept.cwd, "notes.cs"), "left out of the proposal\n");
  const revision = yield* service.freeze(workspaceTarget(kept));
  const prepared = yield* service.prepare({
    ...workspaceTarget(kept),
    revisionId: revision.revisionId,
  });
  const integrated = yield* service.integrate({
    ...workspaceTarget(kept),
    revisionId: revision.revisionId,
    preparationId: prepared.preparationId,
  });
  expect(integrated.uncapturedPaths).toEqual(["notes.cs"]);
  const active = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  const predecessor = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* service.fork(workspaceTarget(predecessor));
  yield* service.discard(workspaceTarget(predecessor));
  for (const handle of [expired, kept, active, predecessor])
    yield* age(agent, handle.workspaceId, 8);

  const registry = path.join(agent, "git-workspaces");
  const remaining = yield* Effect.gen(function* () {
    const restarted = yield* WorkspaceService;
    return (yield* restarted.listAll).records.map((record) => record.handle.workspaceId);
  }).pipe(Effect.provide(WorkspaceService.layer({ agentDirectory: agent })));
  expect(remaining).not.toContain(expired.workspaceId);
  for (const handle of [recent, kept, active, predecessor])
    expect(remaining).toContain(handle.workspaceId);
  expect(yield* exists(path.join(registry, expired.workspaceId))).toBe(false);
  expect((yield* io(() => fs.readdir(registry))).some((name) => name.startsWith("."))).toBe(false);
});
