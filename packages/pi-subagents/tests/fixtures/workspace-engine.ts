import * as Effect from "effect/Effect";
import type { WorkspaceServiceContract } from "../../src/workspace/service.ts";

/**
 * A workspace engine that only creates isolated checkouts, `workspace-1` onwards; any other
 * operation is a defect. Each create first runs `beforeCreate` with its ordinal, so a test can
 * note or hold the checkout.
 */
export const createOnlyWorkspaceEngine = (
  beforeCreate: (ordinal: number) => Effect.Effect<void> = () => Effect.void,
): WorkspaceServiceContract => {
  let created = 0;
  const unused = () => Effect.die(new Error("Unexpected workspace operation."));
  return {
    create: ({ sourceCwd, ownerId }) =>
      Effect.suspend(() => {
        const ordinal = ++created;
        const workspaceId = `workspace-${ordinal}`;
        return beforeCreate(ordinal).pipe(
          Effect.as({
            workspaceId,
            ownerId,
            sourceCwd,
            sourceRoot: sourceCwd,
            cwd: `/private/${workspaceId}`,
          }),
        );
      }),
    freeze: unused,
    prepare: unused,
    integrate: unused,
    revise: unused,
    fork: unused,
    discard: unused,
    discardUnchanged: unused,
    recoverDiscard: unused,
    inspect: unused,
    list: unused,
    listAll: unused,
  };
};
