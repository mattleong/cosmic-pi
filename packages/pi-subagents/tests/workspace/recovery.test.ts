import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { nodeFsPromises as fs, nodePath as path } from "../../src/boundary/node-builtins.ts";
import { WorkspaceService } from "../../src/workspace/service.ts";
import {
  commitRepository,
  exists,
  failureOf,
  io,
  temporaryDirectory,
  workspaceTarget,
  workspaceTests,
  writeFile,
} from "./fixtures/repository.ts";

const openService = (agentDirectory: string) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(WorkspaceService.layer({ agentDirectory }), scope);
    return {
      service: Context.get(context, WorkspaceService),
      close: Scope.close(scope, Exit.void),
    };
  });

it.live(
  "discards an orphan only once the session that created it has ended",
  () =>
    Effect.gen(function* () {
      const temporary = yield* temporaryDirectory("pi-orphan-");
      const source = path.join(temporary, "source");
      const agent = path.join(temporary, "agent");
      yield* io(() => fs.mkdir(agent, { mode: 0o700 }));
      yield* commitRepository(source, [["main.ts", "baseline\n"]]);
      const creator = yield* openService(agent);
      const handle = yield* creator.service.create({ sourceCwd: source, ownerId: "old/root" });
      yield* writeFile(path.join(handle.cwd, "main.ts"), "unreviewed\n");
      const successor = yield* openService(agent);
      const target = { workspaceId: handle.workspaceId };
      expect((yield* failureOf(successor.service.discardOrphan(target))).operation).toBe(
        "authorization",
      );
      expect((yield* failureOf(creator.service.discardOrphan(target))).operation).toBe(
        "authorization",
      );
      expect(yield* exists(handle.cwd)).toBe(true);
      yield* creator.close;
      yield* successor.service.discardOrphan(target);
      expect(yield* exists(handle.cwd)).toBe(false);
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
