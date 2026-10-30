import * as Schema from "effect/Schema";
import type { BackgroundTaskStatus } from "./model.ts";
import { detailsSnapshot } from "./redaction.ts";
import { BackgroundTaskSnapshotSchema } from "./schema.ts";

/** The custom message type an exit notice is delivered and stored as. */
export const TASK_NOTICE_MESSAGE_TYPE = "pi-background-task-finished";

/** The most of a task's newest output a stored notice keeps for display. */
export const MAX_NOTICE_TAIL_CHARS = 8_000;

/**
 * What a stored notice keeps for its renderer: the finished task, bounded and redacted, and its
 * newest output as the user sees it, redacted and empty when it printed none.
 */
export const TaskNoticeDetailsSchema = Schema.Struct({
  task: BackgroundTaskSnapshotSchema,
  tail: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(MAX_NOTICE_TAIL_CHARS))),
});
export type TaskNoticeDetails = typeof TaskNoticeDetailsSchema.Type;

export const taskNoticeDetails = (task: BackgroundTaskStatus, tail: string): TaskNoticeDetails => ({
  task: detailsSnapshot(task),
  tail,
});
