import * as Effect from "effect/Effect";
import type { WorkspaceSetup } from "../config/schema.ts";
import type { WorkspaceHandle } from "../workspace/model.ts";
import type { WorkspaceServiceContract } from "../workspace/service.ts";
import { invalidRequest as invalid, type SubagentError } from "./errors.ts";
import { mapWorkspaceError } from "./workspace-binding.ts";

const MAX_LISTED_CHANGES = 5;

/**
 * Runs the project's setup command at the root of an isolated tree, then requires that it changed
 * only ignored or excluded files so dependencies never become part of a proposal or test tree.
 * Unconfirmed cleanup leaves the engine's durable marker, which keeps the workspace quarantined.
 */
export const provisionWorkspaceTree = (
  service: WorkspaceServiceContract,
  setup: WorkspaceSetup,
  handle: WorkspaceHandle,
  tree: { readonly preparationId?: string | undefined },
): Effect.Effect<void, SubagentError> =>
  Effect.gen(function* () {
    yield* service
      .setup({
        workspaceId: handle.workspaceId,
        ownerId: handle.ownerId,
        preparationId: tree.preparationId,
        setup,
      })
      .pipe(
        Effect.mapError((error) =>
          invalid(
            error.cleanupUnconfirmed
              ? "workspace_setup_cleanup_unconfirmed"
              : "workspace_setup_failed",
            error.detail === undefined ? error.message : `${error.message}\n${error.detail}`,
          ),
        ),
      );
    const changed = yield* service
      .setupChanges({
        workspaceId: handle.workspaceId,
        ownerId: handle.ownerId,
        preparationId: tree.preparationId,
      })
      .pipe(Effect.mapError(mapWorkspaceError));
    if (changed.length === 0) return undefined;
    const listed = changed.slice(0, MAX_LISTED_CHANGES).join(", ");
    const more =
      changed.length > MAX_LISTED_CHANGES
        ? `, and ${changed.length - MAX_LISTED_CHANGES} more`
        : "";
    return yield* invalid(
      "workspace_setup_failed",
      `Workspace setup changed project files (${listed}${more}); add its outputs to .gitignore.`,
    );
  });
