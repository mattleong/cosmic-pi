import * as Effect from "effect/Effect";
import { WorkspaceError } from "../workspace/model.ts";
import type {
  WorkspaceExport,
  WorkspaceExportRequest,
  WorkspaceRecord,
  WorkspaceRevisionMetadata,
} from "../workspace/model.ts";
import { userCommitIdentity } from "./git-installation.ts";
import { nodeErrorCode } from "./harness-shared.ts";
import { nodeFsPromises as fs, nodePath as path } from "./node-builtins.ts";
import {
  applyConflictPaths,
  checkDirectory,
  git,
  gitFailure,
  gitFields,
  gitResult,
  gitStderrLines,
  gitSucceeded,
  type GitResult,
  listedPaths,
  oid,
  workspaceFailure,
  workspaceIO,
  workspaceRefusal,
  writeWorkspaceFile,
} from "./git-worktree-process.ts";
import { newWorkspaceId } from "./git-worktree-store.ts";
import { patchBytes, revisionPatchBytes } from "./git-worktree-patch.ts";
import {
  captureTree,
  workspaceArtifact,
  workspaceRepository,
  workspaceWorker,
} from "./git-worktree-trees.ts";

/** Exported patches live in the repository's own Git directory, never in its working tree. */
const EXPORT_DIRECTORY = "pi-subagents";
/** The common Git directory, which linked worktrees share and which keeps the branches. */
const commonGitDirectory = (sourceRoot: string) =>
  git(sourceRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).pipe(
    Effect.flatMap((output) => {
      const directory = output.replace(/\n$/u, "");
      return directory === "" || /\p{Cc}/u.test(directory)
        ? Effect.fail(workspaceFailure("export", "Git reported an unusable Git directory."))
        : checkDirectory(directory);
    }),
  );

/**
 * Writes the patch to `<git-dir>/pi-subagents/<workspace>-<revision>.patch`. The name is
 * deterministic for the revision, so exporting it again replaces the same file atomically.
 */
export const writePatchExport = (
  sourceRoot: string,
  workspaceId: string,
  revisionId: string,
  bytes: Uint8Array,
) =>
  Effect.gen(function* () {
    const directory = path.join(yield* commonGitDirectory(sourceRoot), EXPORT_DIRECTORY);
    yield* workspaceIO("export", () =>
      fs.mkdir(directory, { mode: 0o700 }).catch((cause: unknown) => {
        if (nodeErrorCode(cause) !== "EEXIST") throw cause;
      }),
    );
    yield* checkDirectory(directory);
    const file = path.join(directory, `${workspaceId}-${revisionId.slice(0, 12)}.patch`);
    const temporary = path.join(directory, `.${yield* newWorkspaceId}.tmp`);
    yield* Effect.gen(function* () {
      yield* writeWorkspaceFile(temporary, bytes, 0o600);
      yield* workspaceIO("export", () => fs.rename(temporary, file));
    }).pipe(
      Effect.ensuring(
        workspaceIO("export", () => fs.rm(temporary, { force: true })).pipe(Effect.ignore),
      ),
    );
    return file;
  });

const branchExists = (branch: string) =>
  new WorkspaceError({
    operation: "export",
    code: "workspace_branch_exists",
    message: `Branch ${branch} already exists, so nothing was exported.`,
    detail: `Remedy: delete or rename that branch (git branch -D ${branch}) and export again, or export with format patch.`,
  });

const branchConflict = (result: GitResult, changedPaths: ReadonlyArray<string>) => {
  const paths = applyConflictPaths(result.stderr, changedPaths);
  const stderr = gitStderrLines(result.stderr);
  return new WorkspaceError({
    operation: "export",
    code: "workspace_conflict",
    message: "The proposal doesn't apply to the source HEAD's files, so no branch was created.",
    detail: [
      ...(paths.length > 0 ? [`Conflicting: ${listedPaths(paths)}`] : []),
      ...(stderr.length > 0 ? [`Git reported:\n${stderr.join("\n")}`] : []),
      "The proposal was captured from the checkout's files, uncommitted edits included, so it builds on them rather than on HEAD.",
      "Remedy: export with format patch and apply it to the checkout, or commit the local edits it builds on and export again.",
    ].join("\n"),
  });
};

/**
 * Creates `branch` in the source repository with one commit whose parent is HEAD and whose tree
 * is HEAD's tree with the patch applied, authored and committed as the user. Plumbing through a
 * temporary index in `scratch` leaves the user's index, HEAD, and working tree untouched; an
 * existing branch is never replaced.
 */
export const writeBranchExport = (input: {
  readonly sourceRoot: string;
  readonly scratch: string;
  readonly branch: string;
  readonly bytes: Uint8Array;
  readonly message: string;
  readonly changedPaths: ReadonlyArray<string>;
}) =>
  Effect.gen(function* () {
    const { sourceRoot, branch } = input;
    const reference = `refs/heads/${branch}`;
    if (!gitSucceeded(yield* gitResult(sourceRoot, ["check-ref-format", reference])))
      return yield* workspaceRefusal("export", "The branch name isn't valid.", {
        path: branch,
        rule: "branch names follow git check-ref-format",
        remedy: "Export with format patch instead.",
      });
    const existing = yield* gitResult(sourceRoot, ["show-ref", "--verify", "--quiet", reference]);
    if (gitSucceeded(existing)) return yield* branchExists(branch);
    const base = yield* git(sourceRoot, [
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      "HEAD^{commit}",
    ]).pipe(Effect.flatMap(oid));
    const identity = yield* userCommitIdentity(sourceRoot);
    const index = path.join(input.scratch, `export-${yield* newWorkspaceId}.index`);
    const environment = { GIT_INDEX_FILE: index };
    return yield* Effect.gen(function* () {
      yield* git(sourceRoot, ["read-tree", base], { environment });
      const applyArgs = ["apply", "--cached", "--binary", "--whitespace=nowarn", "-"];
      const applied = yield* gitResult(sourceRoot, applyArgs, {
        stdin: input.bytes,
        environment,
      });
      if (!gitSucceeded(applied))
        return yield* applied.code !== null && !applied.cleanupUnconfirmed && !applied.timedOut
          ? branchConflict(applied, input.changedPaths)
          : gitFailure(applyArgs, applied);
      const tree = yield* git(sourceRoot, ["write-tree"], { environment }).pipe(
        Effect.flatMap(oid),
      );
      // Only this commit carries the user's identity; every other workspace Git call stays
      // isolated from user configuration.
      const commit = yield* git(
        sourceRoot,
        ["commit-tree", "--no-gpg-sign", tree, "-p", base, "-m", input.message],
        {
          environment: {
            ...(identity.author && {
              GIT_AUTHOR_NAME: identity.author.name,
              GIT_AUTHOR_EMAIL: identity.author.email,
            }),
            ...(identity.committer && {
              GIT_COMMITTER_NAME: identity.committer.name,
              GIT_COMMITTER_EMAIL: identity.committer.email,
            }),
          },
        },
      ).pipe(Effect.flatMap(oid));
      // An all-zero old value creates the branch only while it still doesn't exist.
      const createArgs = ["update-ref", reference, commit, "0".repeat(base.length)];
      const created = yield* gitResult(sourceRoot, createArgs);
      if (!gitSucceeded(created))
        return yield* created.code !== null && !created.cleanupUnconfirmed && !created.timedOut
          ? branchExists(branch)
          : gitFailure(createArgs, created);
      return {
        branch,
        commit,
        base,
        identity: identity.author && identity.committer ? "user" : "placeholder",
      } as const;
    }).pipe(
      Effect.ensuring(
        workspaceIO("export", () =>
          Promise.all([fs.rm(index, { force: true }), fs.rm(`${index}.lock`, { force: true })]),
        ).pipe(Effect.ignore),
      ),
    );
  });

/** A proposal's changed paths and patch bytes, ready to export. */
export type ExportedProposal = Omit<WorkspaceRevisionMetadata, "uncapturedPaths"> & {
  readonly uncapturedPaths: ReadonlyArray<string>;
  readonly bytes: Uint8Array;
};

export const nestedExportRefusal = (record: WorkspaceRecord) =>
  workspaceRefusal("export", "A nested workspace can't be exported.", {
    path: record.handle.sourceRoot,
    rule: "export writes into the real checkout's Git directory, and a nested workspace's source is another workspace's private worker tree",
    remedy: "Apply or discard it into its source workspace instead.",
  });

/** Writes the patch file or branch into the source repository, never into its working tree. */
export const exportProposal = (
  registry: string,
  record: WorkspaceRecord,
  exported: ExportedProposal,
  request: WorkspaceExportRequest,
) =>
  Effect.gen(function* () {
    const { bytes, ...common } = exported;
    if (common.changedPaths.length === 0)
      return yield* workspaceRefusal("export", "The proposal changes no files.", {
        rule: "export writes a proposal's changes, and this revision has none",
        remedy: "Discard the workspace instead.",
      });
    const { sourceRoot, workspaceId } = record.handle;
    if (request.format === "patch")
      return {
        ...common,
        format: "patch",
        path: yield* writePatchExport(sourceRoot, workspaceId, common.revisionId, bytes),
      } satisfies WorkspaceExport;
    const branch = yield* writeBranchExport({
      sourceRoot,
      scratch: workspaceArtifact(registry, record),
      branch: request.branch,
      bytes,
      message: `Pi subagent proposal\n\nWorkspace ${workspaceId}, revision ${common.revisionId}.`,
      changedPaths: common.changedPaths,
    });
    return { ...common, format: "branch", ...branch } satisfies WorkspaceExport;
  });

/** The frozen revision's proposal; `revisionId`, when given, must name it. */
export const frozenProposal = (
  registry: string,
  record: WorkspaceRecord,
  revisionId: string | undefined,
) =>
  Effect.gen(function* () {
    const frozen = record.revision;
    if (
      (record.status !== "frozen" && record.status !== "prepared") ||
      frozen === undefined ||
      (revisionId !== undefined && frozen.revisionId !== revisionId)
    )
      return yield* workspaceFailure("revision", "Reviewed revision is stale or unknown.");
    return {
      revisionId: frozen.revisionId,
      changedPaths: frozen.changedPaths,
      uncapturedPaths: frozen.uncapturedPaths ?? [],
      bytes: yield* revisionPatchBytes(registry, record, frozen),
    } satisfies ExportedProposal;
  });

/**
 * An unfrozen worker tree's proposal, captured into the private repository only, under its own
 * reference, so the record and trees stay unchanged.
 */
export const workerProposal = (registry: string, record: WorkspaceRecord) =>
  Effect.gen(function* () {
    const snapshot = yield* captureTree(
      registry,
      record,
      workspaceWorker(registry, record),
      "export",
    );
    const range = { from: record.baseline, to: snapshot.commit };
    return {
      revisionId: snapshot.commit,
      changedPaths: yield* gitFields(workspaceRepository(registry, record), [
        "diff",
        "--name-only",
        "-z",
        "--no-renames",
        range.from,
        range.to,
        "--",
      ]),
      uncapturedPaths: snapshot.excludedPaths,
      bytes: yield* patchBytes(registry, record, range, "export"),
    } satisfies ExportedProposal;
  });
