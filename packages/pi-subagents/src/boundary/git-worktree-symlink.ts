import * as Effect from "effect/Effect";
import { excludedWorkspacePath, safeWorkspacePath } from "../workspace/policy.ts";
import { nodeFsPromises as fs, nodePath as path } from "./node-builtins.ts";
import { checkDirectory, workspaceFailure, workspaceIO } from "./git-worktree-process.ts";

/** Read only the link text. Its target must be a separately captured regular file. */
export const readWorkspaceSymlink = (
  root: string,
  relative: string,
  includedPaths: ReadonlySet<string>,
) =>
  Effect.gen(function* () {
    const full = path.join(root, relative);
    yield* checkDirectory(path.dirname(full));
    const before = yield* workspaceIO("symlink", () => fs.lstat(full));
    if (!before.isSymbolicLink() || before.nlink !== 1 || before.size > 1024)
      return yield* workspaceFailure("symlink", "Workspace link changed or is unsupported.");
    const bytes = yield* workspaceIO("symlink", () => fs.readlink(full, { encoding: "buffer" }));
    const target = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
      catch: () => workspaceFailure("symlink", "Workspace link target must be UTF-8."),
    });
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), target));
    if (
      !target ||
      path.isAbsolute(target) ||
      // Do not erase unchecked ancestors such as node_modules/.. before validation.
      target !== path.posix.relative(path.posix.dirname(relative), resolved) ||
      /[\\\p{Cc}:]/u.test(target) ||
      !safeWorkspacePath(resolved) ||
      excludedWorkspacePath(resolved) ||
      !includedPaths.has(resolved)
    )
      return yield* workspaceFailure(
        "symlink",
        "Workspace links must point to an included regular file inside the repository.",
      );
    yield* checkDirectory(path.dirname(path.join(root, resolved)));
    // lstat never follows the leaf. Chains, cycles, directories and dangling links fail closed.
    const destination = yield* workspaceIO("symlink", () => fs.lstat(path.join(root, resolved)));
    if (!destination.isFile() || destination.nlink !== 1)
      return yield* workspaceFailure(
        "symlink",
        "Workspace link target must be a regular file, not another link.",
      );
    const after = yield* workspaceIO("symlink", () => fs.lstat(full));
    if (
      !after.isSymbolicLink() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.size !== after.size ||
      after.nlink !== 1
    )
      return yield* workspaceFailure("symlink", "Workspace link changed while reading.");
    return { bytes, mode: "120000", permissions: 0o777, symlinkTarget: resolved };
  });
