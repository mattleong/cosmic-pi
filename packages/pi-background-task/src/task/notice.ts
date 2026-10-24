import * as Schema from "effect/Schema";
import type { BackgroundTaskStatus } from "./model.ts";
import { detailsSnapshot } from "./redaction.ts";
import { BackgroundTaskSnapshotSchema } from "./schema.ts";

/** The custom message type an exit notice is delivered and stored as. */
export const TASK_NOTICE_MESSAGE_TYPE = "pi-background-task-finished";

/** What a stored notice keeps for its renderer: the finished task, bounded and redacted. */
export const TaskNoticeDetailsSchema = Schema.Struct({ task: BackgroundTaskSnapshotSchema });
export type TaskNoticeDetails = typeof TaskNoticeDetailsSchema.Type;

export const taskNoticeDetails = (task: BackgroundTaskStatus): TaskNoticeDetails => ({
  task: detailsSnapshot(task),
});
