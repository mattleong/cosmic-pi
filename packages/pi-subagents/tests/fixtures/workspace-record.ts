import type { WorkspaceHandle, WorkspaceRecord } from "../../src/workspace/model.ts";

/**
 * A saved workspace record with placeholder paths, whose worker tree lies outside its source
 * checkout. `handle` overrides merge into the handle; the rest replace record fields.
 */
export const workspaceRecord = (
  workspaceId: string,
  {
    handle,
    ...overrides
  }: Partial<Omit<WorkspaceRecord, "handle">> & {
    readonly handle?: Partial<WorkspaceHandle>;
  } = {},
): WorkspaceRecord => ({
  version: 2,
  repository: "/source/.git",
  handle: {
    workspaceId,
    ownerId: "parent",
    sourceRoot: "/source",
    sourceCwd: "/source",
    artifactRoot: "/private",
    cwd: "/private/worker",
    ...handle,
  },
  status: "active",
  baseline: "baseline",
  ownerLease: "owner",
  lastChangedAt: 0,
  ...overrides,
});
