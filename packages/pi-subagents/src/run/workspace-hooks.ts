import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import type { WorktreeCreateSetup } from "../config/schema.ts";
import type { WorkspaceHandle } from "../workspace/model.ts";
import type { WorkspaceServiceContract } from "../workspace/service.ts";
import { invalidRequest as invalid, type SubagentError } from "./errors.ts";
import { mapWorkspaceError, workspaceErrorText } from "./workspace-binding.ts";

const MAX_LISTED_CHANGES = 5;

/**
 * Runs the WorktreeCreate hooks at the root of an isolated tree, then requires that they changed
 * only ignored or credential files so dependencies never become part of a proposal or test tree.
 * Setup with an invalid declaration fails before any hook runs, so no tree skips a setup step.
 */
export const runWorktreeCreateHooks = Effect.fn("SubagentWorkspace.runWorktreeCreateHooks")(
  function* (
    service: WorkspaceServiceContract,
    setup: WorktreeCreateSetup,
    handle: WorkspaceHandle,
    tree: { readonly preparationId?: string | undefined; readonly runId?: string | undefined },
  ): Effect.fn.Return<void, SubagentError> {
    if ("invalid" in setup)
      return yield* invalid(
        "workspace_hook_failed",
        `WorktreeCreate hooks are invalid in the subagents configuration (${Arr.join(setup.invalid, ", ")}); fix them and run /reload.`,
      );
    const hooks = setup;
    if (hooks.length === 0) return undefined;
    const target = {
      workspaceId: handle.workspaceId,
      ownerId: handle.ownerId,
      preparationId: tree.preparationId,
    };
    yield* service
      .runCreateHooks({ ...target, hooks, runId: tree.runId })
      .pipe(
        Effect.mapError((error) => invalid("workspace_hook_failed", workspaceErrorText(error))),
      );
    const changed = yield* service.hookChanges(target).pipe(Effect.mapError(mapWorkspaceError));
    if (changed.length === 0) return undefined;
    const listed = Arr.join(changed.slice(0, MAX_LISTED_CHANGES), ", ");
    const more =
      changed.length > MAX_LISTED_CHANGES
        ? `, and ${changed.length - MAX_LISTED_CHANGES} more`
        : "";
    return yield* invalid(
      "workspace_hook_failed",
      `WorktreeCreate hooks changed project files (${listed}${more}); add their outputs to .gitignore.`,
    );
  },
);
