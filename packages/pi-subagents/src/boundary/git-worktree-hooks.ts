import * as Effect from "effect/Effect";
import type { SafeFile } from "pi-cosmic-core";
import type { WorktreeHook } from "../config/schema.ts";
import type { WorkspaceError, WorkspaceRecord } from "../workspace/model.ts";
import { nodeFsPromises as fs, nodePath as path } from "./node-builtins.ts";
import { workspaceIOIfPresent } from "./git-worktree-process.ts";
import { runWorktreeHook, type WorktreeHookInput } from "./worktree-hook.ts";

/** Runs before the engine removes one of a workspace's trees; a failure keeps the tree. */
export type BeforeTreeRemoval = (
  record: WorkspaceRecord,
  tree: string,
) => Effect.Effect<void, WorkspaceError, SafeFile>;

export const worktreeKind = (tree: string): WorktreeHookInput["kind"] =>
  path.basename(tree) === "worker" ? "worker" : "prepare";

/**
 * Runs the WorktreeRemove hooks, best effort, in each present tree before its removal. A hook
 * that fails, times out, or leaves processes its runner couldn't confirm stopped is a logged
 * warning, and the tree is removed anyway. Callers already hold the checkout's store lock.
 */
export const worktreeRemoveHooks = (
  hooks: ReadonlyArray<WorktreeHook>,
): BeforeTreeRemoval | undefined =>
  hooks.length === 0
    ? undefined
    : (record, tree) =>
        Effect.gen(function* () {
          const present = yield* workspaceIOIfPresent("discard", () => fs.lstat(tree));
          if (!present?.isDirectory()) return undefined;
          const { workspaceId } = record.handle;
          const input: WorktreeHookInput = {
            event: "WorktreeRemove",
            workspaceId,
            worktreePath: tree,
            sourceCwd: record.handle.sourceCwd,
            kind: worktreeKind(tree),
          };
          return yield* Effect.forEach(
            hooks,
            (hook) =>
              runWorktreeHook(hook, input).pipe(
                Effect.catch((error) =>
                  Effect.logWarning(`${error.message} The tree is removed anyway.`).pipe(
                    Effect.annotateLogs({ workspaceId, tree }),
                  ),
                ),
              ),
            { discard: true },
          );
        });
