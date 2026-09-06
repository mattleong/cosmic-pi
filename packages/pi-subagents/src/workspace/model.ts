import * as Schema from "effect/Schema";

export class WorkspaceError extends Schema.TaggedError<WorkspaceError>()("WorkspaceError", {
  operation: Schema.String,
  message: Schema.String,
  cleanupUnconfirmed: Schema.optional(Schema.Boolean),
}) {}

export const WorkspaceHandleSchema = Schema.Struct({
  workspaceId: Schema.String,
  ownerId: Schema.String,
  sourceCwd: Schema.String,
  sourceRoot: Schema.String,
  cwd: Schema.String,
});
export type WorkspaceHandle = typeof WorkspaceHandleSchema.Type;
export const WorkspaceRevisionSchema = Schema.Struct({
  revisionId: Schema.String,
  diff: Schema.String,
  changedPaths: Schema.Array(Schema.String),
});
export type WorkspaceRevision = typeof WorkspaceRevisionSchema.Type;
export const WorkspacePreparationSchema = Schema.Struct({
  preparationId: Schema.String,
  revisionId: Schema.String,
  cwd: Schema.String,
  leaseDirectories: Schema.Array(Schema.String),
});
export type WorkspacePreparation = typeof WorkspacePreparationSchema.Type;
export const WorkspaceRecordSchema = Schema.Struct({
  version: Schema.Literal(1),
  handle: WorkspaceHandleSchema,
  status: Schema.Literals([
    "creating",
    "active",
    "frozen",
    "prepared",
    "integrating",
    "integrated",
    "discarded",
  ]),
  baseline: Schema.String,
  excludedPaths: Schema.optional(Schema.Array(Schema.String)),
  revision: Schema.optional(WorkspaceRevisionSchema),
  preparation: Schema.optional(WorkspacePreparationSchema),
  preparedTree: Schema.optional(Schema.String),
  parentTree: Schema.optional(Schema.String),
  sourceHead: Schema.optional(Schema.String),
  sourceIndex: Schema.optional(Schema.String),
  journal: Schema.optional(
    Schema.Array(
      Schema.Struct({
        path: Schema.String,
        temporaryPath: Schema.String,
        backupPath: Schema.String,
        before: Schema.optional(
          Schema.Struct({ oid: Schema.String, mode: Schema.String, permissions: Schema.Finite }),
        ),
        after: Schema.optional(
          Schema.Struct({ oid: Schema.String, mode: Schema.String, permissions: Schema.Finite }),
        ),
      }),
    ),
  ),
  publishedCount: Schema.optional(Schema.Finite),
  plannedDirectories: Schema.optional(Schema.Array(Schema.String)),
  createdDirectoryCount: Schema.optional(Schema.Finite),
});
export type WorkspaceRecord = typeof WorkspaceRecordSchema.Type;
export interface WorkspaceTarget {
  readonly workspaceId: string;
  readonly ownerId: string;
}
export interface WorkspaceSettledTarget extends WorkspaceTarget {
  readonly processCleanupConfirmed: true;
}
export interface WorkspaceRevisionTarget extends WorkspaceTarget {
  readonly revisionId: string;
}
export interface WorkspaceIntegrationTarget extends WorkspaceRevisionTarget {
  readonly preparationId: string;
  readonly processCleanupConfirmed: true;
}
