import { it } from "@effect/vitest";
import { vi } from "vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Fn from "effect/Function";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Str from "effect/String";
import * as os from "node:os";
import { git, workspaceIO } from "../../../src/boundary/git-worktree-process.ts";
import type { WriterLeaseContract } from "../../../src/boundary/writer-lease.ts";
import type { WorkspaceControlDependencies } from "../../../src/run/workspace-binding.ts";
import { nodeFsPromises as fs, nodePath as path } from "../../support/node-builtins.ts";
import type { WorkspaceHandle } from "../../../src/workspace/model.ts";
import { WorkspaceService, type WorkspaceServiceContract } from "../../../src/workspace/service.ts";
import * as Arr from "effect/Array";

// Workspaces run Git with the user's system and global configuration. Tests use none, unless a
// test file points these at a configuration of its own.
vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");

export const io = <A>(run: () => PromiseLike<A>) => workspaceIO("fixture", run);

/** Where the engine keeps its records and linked worktrees for an agent directory. */
export const registryOf = (agent: string) => path.join(agent, "subagent-worktrees");

export const temporaryDirectory = (prefix: string) =>
  Effect.acquireRelease(
    io(() => fs.mkdtemp(path.join(os.tmpdir(), prefix)).then((dir) => fs.realpath(dir))),
    (dir) => io(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
  );

type RepositoryFiles = ReadonlyArray<readonly [file: string, content: string | Uint8Array]>;

export const commitRepository = (root: string, files: RepositoryFiles) =>
  Effect.gen(function* () {
    yield* io(() => fs.mkdir(root, { recursive: true }));
    yield* git(root, ["init", "--template="]);
    for (const [file, content] of files) {
      yield* io(() => fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }));
      yield* io(() => fs.writeFile(path.join(root, file), content));
    }
    yield* git(root, ["add", "--", ...Arr.map(files, ([file]) => file)]);
    yield* git(root, ["commit", "-m", "fixture"]);
  });

export const exists = (target: string) =>
  io(() =>
    fs.access(target).then(
      () => true,
      () => false,
    ),
  );
export const readText = (...parts: ReadonlyArray<string>) =>
  io(() => fs.readFile(path.join(...parts), "utf8"));
export const writeFile = (file: string, content: string | Uint8Array) =>
  io(() => fs.writeFile(file, content));
export const fails = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.exit(effect).pipe(Effect.map(Exit.isFailure));
export const failureOf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flip(effect).pipe(Effect.orDie);

/** A workspace service with its own scope, like another Pi session sharing the agent directory. */
export const openWorkspaceService = (agentDirectory: string) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(WorkspaceService.layer({ agentDirectory }), scope);
    return {
      service: Context.get(context, WorkspaceService),
      close: Scope.close(scope, Exit.void),
    };
  });

/** A checkout with a session that created workspaces in it, which a test ends with `creator.close`. */
export const orphanScenario = (prefix: string, files: RepositoryFiles) =>
  Effect.gen(function* () {
    const temporary = yield* temporaryDirectory(prefix);
    const source = path.join(temporary, "source");
    const agent = path.join(temporary, "agent");
    yield* io(() => fs.mkdir(agent, { mode: 0o700 }));
    yield* commitRepository(source, files);
    const creator = yield* openWorkspaceService(agent);
    return { source, agent, creator };
  });

/** What the root coordinator of a later session sharing the agent directory is built from. */
export const successorDependencies = (
  writerLeases: WriterLeaseContract,
  engine: WorkspaceServiceContract,
  sourceCwd: string,
) =>
  Effect.map(
    Effect.scope,
    (ownerScope): WorkspaceControlDependencies => ({
      ownerScope,
      records: new Map(),
      withLock: (effect) => effect,
      writerLeases,
      engine,
      initialMode: "worktree",
      worktreeCreate: [],
      ownerId: "new",
      sourceCwd,
      isClosed: () => false,
    }),
  );

interface PendingInterrupt {
  interrupt?: () => void;
}

/** Interrupts `effect` just before a record matching `matches` is renamed into place. */
export const interruptAtRecordSave = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  matches: (text: string) => boolean,
) =>
  Effect.gen(function* () {
    const rename = fs.rename;
    const pending: PendingInterrupt = {};
    const spy = vi.spyOn(fs, "rename").mockImplementation((from, to) =>
      fs.readFile(from, "utf8").then((text) => {
        if (Fn.pipe(String(to), Str.endsWith("record.json")) && matches(text))
          pending.interrupt?.();
        return rename(from, to);
      }),
    );
    const fiber = yield* Effect.forkChild(effect);
    pending.interrupt = () => fiber.interruptUnsafe();
    return yield* Fiber.await(fiber).pipe(Effect.ensuring(Effect.sync(() => spy.mockRestore())));
  });

/** The prepared trees a workspace's private directory still holds. */
export const preparedTrees = (artifact: string) =>
  io(() => fs.readdir(artifact)).pipe(
    Effect.map((names) => Arr.filter(names, (name) => Fn.pipe(name, Str.startsWith("prepare-")))),
  );

export const workspaceTarget = (handle: WorkspaceHandle) => ({
  workspaceId: handle.workspaceId,
  ownerId: handle.ownerId,
  processCleanupConfirmed: true as const,
});

/** Freezes and prepares the worker's changes, returning the request that integrates them. */
export const prepareIntegration = (service: WorkspaceServiceContract, handle: WorkspaceHandle) =>
  Effect.gen(function* () {
    const revision = yield* service.freeze(workspaceTarget(handle));
    const prepared = yield* service.prepare({
      ...workspaceTarget(handle),
      revisionId: revision.revisionId,
    });
    const integration = {
      ...workspaceTarget(handle),
      revisionId: revision.revisionId,
      preparationId: prepared.preparationId,
    };
    return { revision, prepared, integration };
  });

/**
 * Runs `integration` with the removal of `file` from the parent checkout failing, as a crash after
 * the checkout step would: new and changed files already hold the proposal. Returns the failure.
 */
export const integrateFailingRemoval = (
  service: WorkspaceServiceContract,
  integration: Parameters<WorkspaceServiceContract["integrate"]>[0],
  file: string,
) => {
  const rm = fs.rm;
  const spy = vi
    .spyOn(fs, "rm")
    .mockImplementation((target, options) =>
      String(target) === file
        ? Promise.reject(Object.assign(new Error("injected"), { code: "EIO" }))
        : rm(target, options),
    );
  return failureOf(service.integrate(integration)).pipe(
    Effect.ensuring(Effect.sync(() => spy.mockRestore())),
  );
};

/**
 * Commits `files`, then untracks `untrack` so those paths stay in history and on disk only. `layer`
 * configures the engine, such as its WorktreeRemove hooks.
 */
export const workspaceTests =
  (
    files: RepositoryFiles,
    untrack: ReadonlyArray<string> = [],
    layer: Omit<Parameters<typeof WorkspaceService.layer>[0], "agentDirectory"> = {},
  ) =>
  (
    name: string,
    body: (
      service: WorkspaceServiceContract,
      root: string,
      agent: string,
    ) => Generator<Effect.Effect<unknown, Error, WorkspaceService | Scope.Scope>, void, unknown>,
  ) =>
    it.live(
      name,
      () =>
        Effect.gen(function* () {
          const temporary = yield* temporaryDirectory("pi-worktree-test-");
          const root = path.join(temporary, "source");
          const agent = path.join(temporary, "agent");
          yield* io(() => fs.mkdir(agent, { mode: 0o700 }));
          yield* commitRepository(root, files);
          if (untrack.length > 0) {
            yield* git(root, ["rm", "--cached", "-q", "--", ...untrack]);
            yield* git(root, ["commit", "-m", "untrack"]);
          }
          yield* Effect.gen(function* () {
            yield* body(yield* WorkspaceService, root, agent);
          }).pipe(Effect.provide(WorkspaceService.layer({ ...layer, agentDirectory: agent })));
        }),
      60_000,
    );
