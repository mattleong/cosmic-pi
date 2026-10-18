import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { SafeFile } from "pi-cosmic-core";
import type { WorktreeHook } from "../config/schema.ts";
import { WorkspaceError, type WorkspaceRecord } from "../workspace/model.ts";
import { nodeFsPromises as fs, nodePath as path } from "./node-builtins.ts";
import { workspaceIOIfPresent } from "./git-worktree-process.ts";
import { readWorkspaceRecord, saveWorkspaceRecord } from "./git-worktree-store.ts";
import { runWorktreeHook, type WorktreeHookInput } from "./worktree-hook.ts";

/** Runs before the engine removes one of a workspace's trees; a failure keeps the tree. */
export type BeforeTreeRemoval = (
  record: WorkspaceRecord,
  tree: string,
) => Effect.Effect<void, WorkspaceError, SafeFile>;

export const worktreeKind = (tree: string): WorktreeHookInput["kind"] =>
  path.basename(tree) === "worker" ? "worker" : "prepare";

/** Shown wherever a hook's unconfirmed cleanup quarantines an artifact. */
export const HOOK_QUARANTINE_REMEDY =
  "Independently confirm the hook's process and every descendant have stopped. Preserve the proposal and recovery record before manually recovering the private trees; restarting Pi does not clear this quarantine.";

const quarantined = (message: string, tree: string, detail?: string) =>
  new WorkspaceError({
    operation: "hook",
    message,
    detail: [detail, `Hook tree: ${tree}`, HOOK_QUARANTINE_REMEDY]
      .filter((line) => line !== undefined)
      .join("\n"),
    cleanupUnconfirmed: true,
  });

/**
 * Runs the WorktreeRemove hooks, best effort, in each present tree before its removal. A failing
 * hook is a logged warning. The durable marker is set first and cleared once every hook's
 * process group is confirmed stopped; unconfirmed cleanup keeps the marker, which quarantines
 * the artifact, and refuses the removal. Callers already hold the checkout's store lock.
 */
export const worktreeRemoveHooks = (
  registry: string,
  hooks: ReadonlyArray<WorktreeHook>,
): BeforeTreeRemoval | undefined =>
  hooks.length === 0
    ? undefined
    : (record, tree) =>
        Effect.gen(function* () {
          const present = yield* workspaceIOIfPresent("discard", () => fs.lstat(tree));
          if (!present?.isDirectory()) return undefined;
          const { workspaceId } = record.handle;
          const current = yield* readWorkspaceRecord(registry, workspaceId);
          yield* saveWorkspaceRecord(registry, { ...current, setupCleanupPending: tree }).pipe(
            Effect.mapError((error) =>
              quarantined(
                "WorktreeRemove couldn't record its quarantine marker; the tree is kept.",
                tree,
                error.message,
              ),
            ),
          );
          let confirmed = true;
          const input: WorktreeHookInput = {
            event: "WorktreeRemove",
            workspaceId,
            worktreePath: tree,
            sourceCwd: record.handle.sourceCwd,
            kind: worktreeKind(tree),
          };
          const clearMarker = Effect.gen(function* () {
            const marked = yield* readWorkspaceRecord(registry, workspaceId);
            const { setupCleanupPending: _pending, ...cleared } = marked;
            yield* saveWorkspaceRecord(registry, cleared);
          }).pipe(
            Effect.mapError((error) =>
              quarantined(
                "WorktreeRemove finished, but its quarantine couldn't be cleared; the tree is kept.",
                tree,
                error.message,
              ),
            ),
          );
          return yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const exit = yield* restore(
                Effect.forEach(
                  hooks,
                  (hook) =>
                    runWorktreeHook(hook, input, {
                      onCleanup: (stopped) => {
                        if (!stopped) confirmed = false;
                      },
                    }).pipe(
                      Effect.catchIf(
                        (error) => error.cleanupUnconfirmed !== true,
                        (error) =>
                          Effect.logWarning(`${error.message} The tree is removed anyway.`).pipe(
                            Effect.annotateLogs({ workspaceId, tree }),
                          ),
                      ),
                      Effect.mapError((error) =>
                        quarantined(`${error.message} The tree is kept.`, tree),
                      ),
                    ),
                  { discard: true },
                ),
              ).pipe(Effect.exit);
              if (Exit.isSuccess(exit)) return yield* clearMarker;
              // Interrupted: the marker stays unless every hook's processes were confirmed stopped.
              if (Cause.hasInterrupts(exit.cause) && confirmed)
                yield* clearMarker.pipe(Effect.ignore);
              return yield* exit;
            }),
          );
        });
