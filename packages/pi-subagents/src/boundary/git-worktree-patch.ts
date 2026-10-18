import * as Effect from "effect/Effect";
import type {
  WorkspaceError,
  WorkspaceRecord,
  WorkspaceRevisionMetadata,
} from "../workspace/model.ts";
import { nodeFsPromises as fs, nodePath as path } from "./node-builtins.ts";
import { git, workspaceFailure, workspaceIO } from "./git-worktree-process.ts";
import { decodeRevisionDiff } from "./git-worktree-snapshot.ts";
import {
  commitRevisionDiff,
  MAX_REVISION_DIFF_BYTES,
  newWorkspaceId,
  readRevisionDiff,
  revisionDiffExists,
} from "./git-worktree-store.ts";
import { workspaceArtifact, workspaceRepository } from "./git-worktree-trees.ts";

// Git pathspec magic that matches the path exactly, whatever characters it holds.
const literalPathspec = (name: string) => `:(literal)${name}`;

export interface PatchRange {
  readonly from: string;
  readonly to: string;
}

/**
 * Git's stdout reaches us decoded as UTF-8, which would silently replace the bytes of a text
 * file that isn't UTF-8, so a patch goes through a private file, bounded like a revision's.
 * `paths` limits it to those exact paths.
 */
export const withPatchFile = <A, R>(
  registry: string,
  record: WorkspaceRecord,
  range: PatchRange,
  operation: string,
  use: (file: string) => Effect.Effect<A, WorkspaceError, R>,
  paths: ReadonlyArray<string> = [],
) =>
  Effect.gen(function* () {
    const output = path.join(workspaceArtifact(registry, record), `${yield* newWorkspaceId}.diff`);
    return yield* Effect.gen(function* () {
      yield* git(workspaceRepository(registry, record), [
        "diff",
        "--binary",
        "--full-index",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        `--output=${output}`,
        range.from,
        range.to,
        "--",
        ...paths.map(literalPathspec),
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
  paths?: ReadonlyArray<string>,
) =>
  withPatchFile(
    registry,
    record,
    range,
    operation,
    (file) => workspaceIO(operation, () => fs.readFile(file)),
    paths,
  );

/**
 * Writes the patch from the record's baseline to `commit`, checks that it decodes strictly, and
 * commits it as the workspace's revision patch beside the record. Returns the decoded text.
 */
export const commitRevisionPatch = (
  registry: string,
  record: WorkspaceRecord,
  commit: string,
  changedPaths: ReadonlyArray<string>,
  operation: string,
) =>
  withPatchFile(registry, record, { from: record.baseline, to: commit }, operation, (output) =>
    Effect.gen(function* () {
      const bytes = yield* workspaceIO(operation, () => fs.readFile(output));
      const diff = yield* decodeRevisionDiff(bytes, changedPaths);
      yield* commitRevisionDiff(registry, record.handle.workspaceId, output);
      return { bytes, diff };
    }),
  );

/**
 * The frozen revision's patch bytes. Records frozen by earlier versions kept the patch inline and
 * have no revision.diff, so it is regenerated from the private repository with freeze's options
 * and persisted. Writing it needs the workspace's store lock.
 */
export const revisionPatchBytes = (
  registry: string,
  record: WorkspaceRecord,
  revision: WorkspaceRevisionMetadata,
) =>
  Effect.gen(function* () {
    const { workspaceId } = record.handle;
    if (yield* revisionDiffExists(registry, workspaceId))
      return yield* readRevisionDiff(registry, workspaceId);
    const regenerated = yield* commitRevisionPatch(
      registry,
      record,
      revision.revisionId,
      revision.changedPaths,
      "revision",
    );
    return regenerated.bytes;
  });
