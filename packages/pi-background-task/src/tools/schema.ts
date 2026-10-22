import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { BACKGROUND_TASK_FIELD_BOUNDS } from "../task/bounds.ts";
import { BACKGROUND_TASK_ACTIONS } from "../task/schema.ts";

export const BackgroundTaskParameters = Type.Object({
  action: StringEnum(BACKGROUND_TASK_ACTIONS, { description: "Background task operation" }),
  command: Type.Optional(
    Type.String({
      maxLength: BACKGROUND_TASK_FIELD_BOUNDS.maxCommandChars,
      description: "Shell command for start",
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      maxLength: BACKGROUND_TASK_FIELD_BOUNDS.maxCwdChars,
      description: "Working directory for start, relative to the session cwd by default",
    }),
  ),
  name: Type.Optional(
    Type.String({
      maxLength: BACKGROUND_TASK_FIELD_BOUNDS.maxNameChars,
      description: "Short optional display name for start",
    }),
  ),
  timeoutSeconds: Type.Optional(
    Type.Number({
      minimum: 0.001,
      description: "Runtime limit for start; omitted means no timeout",
    }),
  ),
  id: Type.Optional(
    Type.String({
      maxLength: BACKGROUND_TASK_FIELD_BOUNDS.maxIdChars,
      description: "Task ID for status, logs, wait, or stop",
    }),
  ),
  state: Type.Optional(
    StringEnum(["active", "completed", "all"] as const, { description: "Filter for list" }),
  ),
  until: Type.Optional(
    StringEnum(["exit", "output"] as const, {
      description:
        'Required for wait. Use "exit" for process completion or "output" for a literal text match.',
    }),
  ),
  contains: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: BACKGROUND_TASK_FIELD_BOUNDS.maxContainsChars,
      description: 'Literal text required for until="output"; invalid for until="exit".',
    }),
  ),
  afterCursor: Type.Optional(
    Type.Integer({
      minimum: 0,
      description:
        'Read logs or match output after this cursor; invalid for until="exit" and with tailLines.',
    }),
  ),
  tailLines: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: `Newest lines for logs, capped at ${BACKGROUND_TASK_FIELD_BOUNDS.maxTailLines}; invalid with afterCursor`,
    }),
  ),
  waitSeconds: Type.Optional(
    Type.Number({
      minimum: 0,
      description:
        "Long-poll seconds for logs or wait, capped by the maxWaitSeconds setting; wait defaults to that cap",
    }),
  ),
  force: Type.Optional(
    Type.Boolean({ description: "Force immediate process-tree termination for stop or stop_all" }),
  ),
});

export type BackgroundTaskToolInput = Static<typeof BackgroundTaskParameters>;
