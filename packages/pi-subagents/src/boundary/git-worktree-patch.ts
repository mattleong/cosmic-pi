import * as Effect from "effect/Effect";
import type { WorkspaceError, WorkspaceRecord } from "../workspace/model.ts";
import { nodeFsPromises as fs, nodePath as path } from "./node-builtins.ts";
import { repositoryGit, workspaceFailure, workspaceIO } from "./git-worktree-process.ts";
import {
  commitRevisionDiff,
  MAX_REVISION_DIFF_BYTES,
  newWorkspaceId,
} from "./git-worktree-store.ts";
import { workspaceArtifact } from "./git-worktree-trees.ts";

interface PatchRange {
  readonly from: string;
  readonly to: string;
}

/**
 * Git's stdout reaches us decoded as UTF-8, which would silently replace the bytes of a text
 * file that isn't UTF-8, so a patch goes through a private file, bounded like a revision's.
 * Plumbing with explicit prefixes keeps the user's diff settings out of a patch `git apply`
 * reads back.
 */
const withPatchFile = <A, R>(
  registry: string,
  record: WorkspaceRecord,
  range: PatchRange,
  operation: string,
  use: (file: string) => Effect.Effect<A, WorkspaceError, R>,
) =>
  Effect.gen(function* () {
    const output = path.join(workspaceArtifact(registry, record), `${yield* newWorkspaceId}.diff`);
    return yield* Effect.gen(function* () {
      yield* repositoryGit(record.repository, [
        "diff-tree",
        "-r",
        "-p",
        "--binary",
        "--full-index",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--no-color",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        `--output=${output}`,
        range.from,
        range.to,
      ]);
      const size = (yield* workspaceIO(operation, () => fs.lstat(output))).size;
      if (size > MAX_REVISION_DIFF_BYTES)
        return yield* workspaceFailure(operation, "The proposal's patch is too large.");
      return yield* use(output);
    }).pipe(
      Effect.ensuring(
        workspaceIO(operation, () => fs.rm(output, { force: true })).pipe(Effect.ignore),
      ),
    );
  });

export const patchBytes = (
  registry: string,
  record: WorkspaceRecord,
  range: PatchRange,
  operation: string,
) =>
  withPatchFile(registry, record, range, operation, (file) =>
    workspaceIO(operation, () => fs.readFile(file)),
  );

/**
 * Review pages are text. Bytes that aren't UTF-8, as in a changed Latin-1 file, show as
 * replacement characters there; preparation applies the stored patch's exact bytes.
 */
export const revisionText = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/**
 * Writes the patch from the record's baseline to `commit` and commits it as the workspace's
 * revision patch beside the record. Returns its text.
 */
export const commitRevisionPatch = (
  registry: string,
  record: WorkspaceRecord,
  commit: string,
  operation: string,
) =>
  withPatchFile(registry, record, { from: record.baseline, to: commit }, operation, (output) =>
    Effect.gen(function* () {
      const bytes = yield* workspaceIO(operation, () => fs.readFile(output));
      yield* commitRevisionDiff(registry, record.handle.workspaceId, output);
      return revisionText(bytes);
    }),
  );
