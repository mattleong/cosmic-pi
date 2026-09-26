// Temporary directories and committed git repositories shared by the workspace suites.
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as os from "node:os";
import { git, workspaceIO } from "../../../src/boundary/git-worktree-process.ts";
import { nodeFsPromises as fs, nodePath as path } from "../../../src/boundary/node-builtins.ts";

export const io = <A>(run: () => PromiseLike<A>) => workspaceIO("fixture", run);

/** A real temporary directory removed, best effort, when the enclosing scope closes. */
export const temporaryDirectory = (prefix: string) =>
  Effect.acquireRelease(
    io(() => fs.mkdtemp(path.join(os.tmpdir(), prefix)).then((dir) => fs.realpath(dir))),
    (dir) => io(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
  );

/** Initializes `root` as a repository whose single commit holds exactly `files`. */
export const commitRepository = (
  root: string,
  files: ReadonlyArray<readonly [file: string, content: string | Uint8Array]>,
) =>
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
export const fails = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.exit(effect).pipe(Effect.map(Exit.isFailure));
