// Temporary directories and committed git repositories shared by the workspace suites.
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Scope from "effect/Scope";
import * as os from "node:os";
import { git, workspaceIO } from "../../../src/boundary/git-worktree-process.ts";
import { nodeFsPromises as fs, nodePath as path } from "../../../src/boundary/node-builtins.ts";
import type { WorkspaceHandle } from "../../../src/workspace/model.ts";
import { WorkspaceService, type WorkspaceServiceContract } from "../../../src/workspace/service.ts";

export const io = <A>(run: () => PromiseLike<A>) => workspaceIO("fixture", run);

/** A real temporary directory removed, best effort, when the enclosing scope closes. */
export const temporaryDirectory = (prefix: string) =>
  Effect.acquireRelease(
    io(() => fs.mkdtemp(path.join(os.tmpdir(), prefix)).then((dir) => fs.realpath(dir))),
    (dir) => io(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
  );

type RepositoryFiles = ReadonlyArray<readonly [file: string, content: string | Uint8Array]>;

/** Initializes `root` as a repository whose single commit holds exactly `files`. */
export const commitRepository = (root: string, files: RepositoryFiles) =>
  Effect.gen(function* () {
    yield* io(() => fs.mkdir(root, { recursive: true }));
    yield* git(root, ["init", "--template="]);
    for (const [file, content] of files) {
      yield* io(() => fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }));
      yield* io(() => fs.writeFile(path.join(root, file), content));
    }
    yield* git(root, ["add", "--", ...files.map(([file]) => file)]);
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
/** The error `effect` fails with; a success fails the test. */
export const failureOf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flip(effect).pipe(Effect.orDie);

/** The target a parent names its own workspace by, after confirming its writer's cleanup. */
export const workspaceTarget = (handle: WorkspaceHandle) => ({
  workspaceId: handle.workspaceId,
  ownerId: handle.ownerId,
  processCleanupConfirmed: true as const,
});

/**
 * Registers live workspace tests. Each gets a fresh `root` repository whose one commit holds
 * `files`, a private `agent` directory, and its own WorkspaceService over that directory.
 */
export const workspaceTests =
  (files: RepositoryFiles) =>
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
          yield* Effect.gen(function* () {
            yield* body(yield* WorkspaceService, root, agent);
          }).pipe(Effect.provide(WorkspaceService.layer({ agentDirectory: agent })));
        }),
      60_000,
    );
