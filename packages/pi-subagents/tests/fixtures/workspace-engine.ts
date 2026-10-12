import * as Effect from "effect/Effect";
import type { WorkspaceServiceContract } from "../../src/workspace/service.ts";

const unused = () => Effect.die(new Error("Unexpected workspace operation."));

export const createOnlyWorkspaceEngine = (): WorkspaceServiceContract => {
  let created = 0;
  return {
    create: ({ sourceCwd, ownerId }) =>
      Effect.sync(() => {
        const workspaceId = `workspace-${++created}`;
        return {
          workspaceId,
          ownerId,
          sourceCwd,
          sourceRoot: sourceCwd,
          cwd: `/private/${workspaceId}`,
        };
      }),
    freeze: unused,
    prepare: unused,
    integrate: unused,
    revise: unused,
    fork: unused,
    discard: unused,
    discardUnchanged: unused,
    inspect: unused,
    list: unused,
    listAll: unused(),
  };
};
