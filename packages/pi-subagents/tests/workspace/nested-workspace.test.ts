import { afterAll, describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as os from "node:os";
import { CrossProcessLock } from "pi-cosmic-core";
import {
  sourceLockNamespace,
  withFreeLock,
  workspaceLockDirectory,
} from "../../src/boundary/git-worktree-store.ts";
import { nodeFsPromises as fs, nodePath as path } from "../../src/boundary/node-builtins.ts";
import { workspaceCheckoutRoot, type WorkspaceHandle } from "../../src/workspace/model.ts";
import type { WorkspaceServiceContract } from "../../src/workspace/service.ts";
import {
  commitRepository,
  exists,
  failureOf,
  io,
  openWorkspaceService,
  readText,
  temporaryDirectory,
  workspaceTarget,
  workspaceTests,
  writeFile,
} from "./fixtures/repository.ts";

// Every Git configuration these tests read comes from this isolated home, rewritten per test.
const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-git-home-")));
const globalConfig = path.join(home, ".gitconfig");
await fs.writeFile(globalConfig, "");
vi.stubEnv("HOME", home);
vi.stubEnv("GIT_CONFIG_GLOBAL", globalConfig);
vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
vi.stubEnv("XDG_CONFIG_HOME", undefined);
afterAll(() => fs.rm(home, { recursive: true, force: true }));

const test = workspaceTests([
  ["src/main.ts", "baseline\n"],
  ["src/util.ts", "util\n"],
  ["docs/guide.md", "guide\n"],
]);

const nested = (
  service: WorkspaceServiceContract,
  parent: WorkspaceHandle,
  sourceCwd = parent.cwd,
) =>
  service.create({
    sourceCwd,
    ownerId: "parent/child",
    sourceWorkspace: { workspaceId: parent.workspaceId, ownerId: parent.ownerId },
  });

const integrate = (service: WorkspaceServiceContract, handle: WorkspaceHandle) =>
  Effect.gen(function* () {
    const target = workspaceTarget(handle);
    const revision = yield* service.freeze(target);
    const preparation = yield* service.prepare({ ...target, revisionId: revision.revisionId });
    return yield* service.integrate({
      ...target,
      revisionId: revision.revisionId,
      preparationId: preparation.preparationId,
    });
  });

describe("nested workspace sources", () => {
  test("snapshots the source worker's uncommitted work with the rules its repository recorded", function* (service, root) {
    const globalIgnore = path.join(home, "global-ignore");
    yield* writeFile(globalIgnore, "global-only.ts\n");
    yield* writeFile(globalConfig, `[core]\n\texcludesFile = ${globalIgnore}\n`);
    yield* io(() => fs.mkdir(path.join(root, ".git", "info"), { recursive: true }));
    yield* writeFile(path.join(root, ".git", "info", "exclude"), "scratch.ts\n");
    const parent = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    yield* writeFile(path.join(parent.cwd, "src/main.ts"), "parent edit\n");
    yield* writeFile(path.join(parent.cwd, "src/added.ts"), "parent addition\n");
    yield* writeFile(path.join(parent.cwd, "global-only.ts"), "ignored\n");
    yield* writeFile(path.join(parent.cwd, "scratch.ts"), "ignored\n");
    // The user's configuration is no longer consulted for the private source, even when broken.
    yield* writeFile(globalConfig, "[core\n");

    const child = yield* nested(service, parent);
    yield* writeFile(globalConfig, "");
    expect(child.sourceWorkspaceId).toBe(parent.workspaceId);
    expect(child.sourceRoot).toBe(parent.cwd);
    expect(workspaceCheckoutRoot(child)).toBe(root);
    expect(yield* readText(child.cwd, "src/main.ts")).toBe("parent edit\n");
    expect(yield* readText(child.cwd, "src/added.ts")).toBe("parent addition\n");
    expect(yield* exists(path.join(child.cwd, "global-only.ts"))).toBe(false);
    expect(yield* exists(path.join(child.cwd, "scratch.ts"))).toBe(false);

    // The child's own captures keep ignoring what the parent ignored.
    yield* writeFile(path.join(child.cwd, "global-only.ts"), "child output\n");
    yield* writeFile(path.join(child.cwd, "scratch.ts"), "child output\n");
    yield* writeFile(path.join(child.cwd, "src/util.ts"), "child edit\n");
    expect((yield* service.freeze(workspaceTarget(child))).changedPaths).toEqual(["src/util.ts"]);
  });

  test("starts from a subdirectory of the source worker", function* (service, root) {
    const parent = yield* service.create({ sourceCwd: path.join(root, "src"), ownerId: "parent" });
    yield* writeFile(path.join(parent.cwd, "main.ts"), "parent edit\n");
    const child = yield* nested(service, parent);
    expect(path.basename(child.cwd)).toBe("src");
    expect(child.sourceCwd).toBe(parent.cwd);
    expect(child.sourceRoot).toBe(path.dirname(parent.cwd));
    expect(yield* readText(child.cwd, "main.ts")).toBe("parent edit\n");
    expect(yield* readText(child.cwd, "..", "docs/guide.md")).toBe("guide\n");
  });

  test("integrates into the source worker, whose next freeze carries it to the checkout", function* (service, root) {
    const parent = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    yield* writeFile(path.join(parent.cwd, "src/main.ts"), "parent edit\n");
    const child = yield* nested(service, parent);
    yield* writeFile(path.join(child.cwd, "src/util.ts"), "child edit\n");
    yield* writeFile(path.join(child.cwd, "src/child.ts"), "child addition\n");
    // The parent keeps working while its child runs; integration publishes beside that work.
    yield* writeFile(path.join(parent.cwd, "docs/guide.md"), "parent later edit\n");

    const childResult = yield* integrate(service, child);
    expect(childResult.record.status).toBe("integrated");
    expect(childResult.retainedForChildren).toBeUndefined();
    expect(yield* exists(child.cwd)).toBe(false);
    expect(yield* readText(parent.cwd, "src/util.ts")).toBe("child edit\n");
    expect(yield* readText(parent.cwd, "src/child.ts")).toBe("child addition\n");
    expect(yield* readText(root, "src/util.ts")).toBe("util\n");

    const parentRevision = yield* service.freeze(workspaceTarget(parent));
    expect(parentRevision.changedPaths.toSorted()).toEqual([
      "docs/guide.md",
      "src/child.ts",
      "src/main.ts",
      "src/util.ts",
    ]);
    const parentTarget = workspaceTarget(parent);
    const preparation = yield* service.prepare({
      ...parentTarget,
      revisionId: parentRevision.revisionId,
    });
    yield* service.integrate({
      ...parentTarget,
      revisionId: parentRevision.revisionId,
      preparationId: preparation.preparationId,
    });
    expect(yield* readText(root, "src/main.ts")).toBe("parent edit\n");
    expect(yield* readText(root, "src/util.ts")).toBe("child edit\n");
    expect(yield* readText(root, "src/child.ts")).toBe("child addition\n");
    expect(yield* readText(root, "docs/guide.md")).toBe("parent later edit\n");
  });

  test("refuses private trees that aren't the named workspace's worker tree", function* (service, root) {
    const parent = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    const other = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    const revision = yield* service.freeze(workspaceTarget(other));
    const preparation = yield* service.prepare({
      ...workspaceTarget(other),
      revisionId: revision.revisionId,
    });
    const directory = path.dirname(parent.cwd);
    const refusals = [
      // A private tree without a named source.
      yield* failureOf(service.create({ sourceCwd: parent.cwd, ownerId: "parent/child" })),
      yield* failureOf(
        service.create({ sourceCwd: path.join(directory, "repo.git"), ownerId: "parent/child" }),
      ),
      // A named source with a tree that isn't its worker.
      yield* failureOf(nested(service, parent, path.join(directory, "repo.git"))),
      yield* failureOf(nested(service, parent, other.cwd)),
      yield* failureOf(nested(service, other, preparation.cwd)),
      yield* failureOf(nested(service, parent, root)),
    ];
    for (const refusal of refusals) {
      expect(refusal.operation).toBe("create");
      expect(refusal.detail).toMatch(/Path: .*\nRule: .*\nRemedy: /u);
    }
    // Only an active source worker can be snapshotted.
    const inactive = yield* failureOf(nested(service, other));
    expect(inactive.message).toMatch(/isn't active/u);
    const records = (yield* service.listAll).records;
    expect(records.map((record) => record.handle.workspaceId).toSorted()).toEqual(
      [parent.workspaceId, other.workspaceId].toSorted(),
    );
  });
});

describe("child guards", () => {
  test("keeps the source worker until its children are resolved", function* (service, root) {
    const parent = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    const child = yield* nested(service, parent);
    expect(yield* service.unresolvedChildren({ workspaceId: parent.workspaceId })).toEqual([
      child.workspaceId,
    ]);
    const refused = yield* failureOf(service.discard(workspaceTarget(parent)));
    expect(refused.detail).toContain(child.workspaceId);
    expect(yield* exists(parent.cwd)).toBe(true);

    yield* service.discard(workspaceTarget(child));
    expect(yield* service.unresolvedChildren({ workspaceId: parent.workspaceId })).toEqual([]);
    yield* service.discard(workspaceTarget(parent));
    expect(yield* exists(parent.cwd)).toBe(false);
  });

  test("keeps an integrated source worker for its children, which can no longer integrate", function* (service, root, agent) {
    const parent = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    yield* writeFile(path.join(parent.cwd, "src/main.ts"), "parent edit\n");
    const child = yield* nested(service, parent);
    yield* writeFile(path.join(child.cwd, "src/util.ts"), "child edit\n");
    const integrated = yield* integrate(service, parent);
    expect(integrated.retainedForChildren).toEqual([child.workspaceId]);
    expect(yield* exists(parent.cwd)).toBe(true);
    expect(yield* readText(root, "src/main.ts")).toBe("parent edit\n");

    const revision = yield* service.freeze(workspaceTarget(child));
    const refused = yield* failureOf(
      service.prepare({ ...workspaceTarget(child), revisionId: revision.revisionId }),
    );
    expect(refused.message).toMatch(/no longer open/u);

    // Collection keeps the parent record the child's attribution needs.
    const seconds = (yield* Clock.currentTimeMillis) / 1000 - 8 * 24 * 60 * 60;
    yield* io(() =>
      fs.utimes(
        path.join(agent, "git-workspaces", parent.workspaceId, "record.json"),
        seconds,
        seconds,
      ),
    );
    const restarted = yield* openWorkspaceService(agent);
    const listing = yield* restarted.service.listAll;
    expect(listing.unavailable).toEqual([]);
    expect(listing.records.map((record) => record.handle.workspaceId).toSorted()).toEqual(
      [parent.workspaceId, child.workspaceId].toSorted(),
    );
    yield* restarted.close;
  });

  it.live(
    "attributes nested orphans to the real checkout and discards children first",
    () =>
      Effect.gen(function* () {
        const temporary = yield* temporaryDirectory("pi-nested-orphan-");
        const source = path.join(temporary, "source");
        const agent = path.join(temporary, "agent");
        yield* io(() => fs.mkdir(agent, { mode: 0o700 }));
        yield* commitRepository(source, [["main.ts", "baseline\n"]]);
        const creator = yield* openWorkspaceService(agent);
        const parent = yield* creator.service.create({ sourceCwd: source, ownerId: "old/root" });
        const child = yield* nested(creator.service, parent);
        const grandchild = yield* nested(creator.service, child);
        yield* creator.close;

        const successor = yield* openWorkspaceService(agent);
        const listing = yield* successor.service.listAll;
        expect(listing.unavailable).toEqual([]);
        expect(listing.records.map((record) => workspaceCheckoutRoot(record.handle))).toEqual([
          source,
          source,
          source,
        ]);
        for (const blocked of [parent, child]) {
          const refused = yield* failureOf(
            successor.service.discardOrphan({ workspaceId: blocked.workspaceId }),
          );
          expect(refused.message).toMatch(/unresolved/u);
          expect(yield* exists(blocked.cwd)).toBe(true);
        }
        for (const handle of [grandchild, child, parent])
          yield* successor.service.discardOrphan({ workspaceId: handle.workspaceId });
        expect((yield* successor.service.listAll).records.map((record) => record.status)).toEqual([
          "discarded",
          "discarded",
          "discarded",
        ]);
        yield* successor.close;
      }),
    60_000,
  );

  test("lists a nested record whose source chain is broken as unavailable", function* (service, root, agent) {
    // Root reads files regardless of their mode.
    if (process.getuid?.() === 0) return;
    const parent = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    const child = yield* nested(service, parent);
    yield* io(() =>
      fs.chmod(path.join(agent, "git-workspaces", parent.workspaceId, "record.json"), 0o000),
    );
    const listing = yield* service.listAll;
    yield* io(() =>
      fs.chmod(path.join(agent, "git-workspaces", parent.workspaceId, "record.json"), 0o600),
    );
    expect(listing.records).toEqual([]);
    expect(listing.unavailable.map((entry) => [entry.workspaceId, entry.reason])).toEqual([
      [parent.workspaceId, "recovery-record-unavailable"],
      [child.workspaceId, "source-workspace-unavailable"],
    ]);
  });
});

describe("chain locking", () => {
  test("serializes child integration with parent operations under the checkout's lock", function* (service, root, agent) {
    const parent = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    const child = yield* nested(service, parent);
    yield* writeFile(path.join(child.cwd, "src/util.ts"), "child edit\n");
    const childTarget = workspaceTarget(child);
    const revision = yield* service.freeze(childTarget);
    const preparation = yield* service.prepare({ ...childTarget, revisionId: revision.revisionId });

    const lockDirectory = workspaceLockDirectory(path.join(agent, "git-workspaces"));
    const held = yield* Effect.gen(function* () {
      const locks = yield* CrossProcessLock;
      // Another session holding the real checkout's lock holds up the whole chain.
      return yield* withFreeLock(
        locks,
        lockDirectory,
        sourceLockNamespace(root),
        Effect.gen(function* () {
          const integration = yield* service
            .integrate({
              ...childTarget,
              revisionId: revision.revisionId,
              preparationId: preparation.preparationId,
            })
            .pipe(Effect.forkChild);
          yield* Effect.sleep(Duration.millis(600));
          expect(integration.pollUnsafe()).toBeUndefined();
          return integration;
        }),
      );
    }).pipe(Effect.provide(CrossProcessLock.layer({ directory: lockDirectory })));
    const integration = Option.getOrThrow(held);

    // A parent operation queued behind the child's integration completes after it.
    const freeze = yield* service.freeze(workspaceTarget(parent)).pipe(Effect.forkChild);
    yield* Fiber.join(integration).pipe(Effect.timeout(Duration.seconds(30)));
    const parentRevision = yield* Fiber.join(freeze).pipe(Effect.timeout(Duration.seconds(30)));
    expect(parentRevision.changedPaths).toEqual(["src/util.ts"]);
    // Another session's operation on the same checkout interleaves with chain operations.
    const concurrent = yield* openWorkspaceService(agent);
    yield* Effect.all(
      [
        concurrent.service.create({ sourceCwd: root, ownerId: "other" }),
        service.revise(workspaceTarget(parent)),
        nested(service, parent),
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.timeout(Duration.seconds(30)));
    yield* concurrent.close;
  });
});
