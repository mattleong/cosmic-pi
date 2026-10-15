import * as Effect from "effect/Effect";
import { dependencyWorkspacePath, safeWorkspacePath } from "../workspace/policy.ts";
import { nodeFsPromises as fs, nodePath as path } from "./node-builtins.ts";
import { checkDirectory, workspaceIO, workspaceRefusal } from "./git-worktree-process.ts";

interface LinkStat {
  isSymbolicLink(): boolean;
  readonly nlink: number;
  readonly size: number;
  readonly dev: number;
  readonly ino: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

const acceptedLinkTarget = (
  relative: string,
  target: string,
  resolved: string,
  includedPaths: ReadonlySet<string>,
) =>
  Boolean(target) &&
  !path.isAbsolute(target) &&
  target === path.posix.relative(path.posix.dirname(relative), resolved) &&
  !/[\\\p{Cc}:]/u.test(target) &&
  safeWorkspacePath(resolved) &&
  !dependencyWorkspacePath(resolved) &&
  includedPaths.has(resolved);

const linkChanged = (before: LinkStat, after: LinkStat) =>
  !after.isSymbolicLink() ||
  before.dev !== after.dev ||
  before.ino !== after.ino ||
  before.mtimeMs !== after.mtimeMs ||
  before.ctimeMs !== after.ctimeMs ||
  before.size !== after.size ||
  after.nlink !== 1;

const LINK_REMEDY =
  "Point the link at a tracked regular file in the repository with a plain relative target, or use the shared-checkout writer workspace.";

export const readWorkspaceSymlink = (
  root: string,
  relative: string,
  includedPaths: ReadonlySet<string>,
) =>
  Effect.gen(function* () {
    const refuse = (message: string, rule: string, remedy = LINK_REMEDY) =>
      workspaceRefusal("symlink", message, { path: relative, rule, remedy });
    const full = path.join(root, relative);
    yield* checkDirectory(path.dirname(full));
    const before = yield* workspaceIO("symlink", () => fs.lstat(full));
    if (!before.isSymbolicLink() || before.nlink !== 1 || before.size > 1024)
      return yield* refuse(
        "A tracked symlink changed or is unsupported.",
        "tracked links must stay single links with targets under 1,024 bytes",
      );
    const bytes = yield* workspaceIO("symlink", () => fs.readlink(full, { encoding: "buffer" }));
    const target = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
      catch: () =>
        refuse("A symlink's target isn't valid UTF-8.", "link targets must be UTF-8 text"),
    });
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), target));
    if (!acceptedLinkTarget(relative, target, resolved, includedPaths))
      return yield* refuse(
        "A symlink points outside the files the snapshot copies.",
        "links must use a canonical relative target naming a captured regular file in the repository",
      );
    yield* checkDirectory(path.dirname(path.join(root, resolved)));
    const destination = yield* workspaceIO("symlink", () => fs.lstat(path.join(root, resolved)));
    if (!destination.isFile() || destination.nlink !== 1)
      return yield* refuse(
        "A symlink points at something other than a regular file.",
        "link targets must be regular files with one hard link, not directories or other links",
      );
    const after = yield* workspaceIO("symlink", () => fs.lstat(full));
    if (linkChanged(before, after))
      return yield* refuse(
        "A symlink changed while it was being copied.",
        "links must stay unchanged while they are copied",
        "Try again once tools stop changing the link.",
      );
    return { bytes, mode: "120000", permissions: 0o777, symlinkTarget: resolved };
  });
