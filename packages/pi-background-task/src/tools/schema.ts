import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { BACKGROUND_TASK_FIELD_BOUNDS } from "../task/bounds.ts";

export const BACKGROUND_TASK_ACTIONS = [
  "start",
  "list",
  "status",
  "logs",
  "wait",
  "stop",
  "stop_all",
  "clear",
] as const;

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
      description: "Short optional display name",
    }),
  ),
  timeoutSeconds: Type.Optional(
    Type.Number({
      minimum: 0.001,
      description: "Optional runtime limit; omitted means no timeout",
    }),
  ),
  id: Type.Optional(
    Type.String({
      maxLength: BACKGROUND_TASK_FIELD_BOUNDS.maxIdChars,
      description: "Task ID for status, logs, wait, or stop",
    }),
  ),
  state: Type.Optional(
    StringEnum(["active", "completed", "all"] as const, { description: "List filter" }),
  ),
  until: Type.Optional(StringEnum(["exit", "output"] as const, { description: "Wait condition" })),
  contains: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 256,
      description: "Literal output text required when waiting for output",
    }),
  ),
  afterCursor: Type.Optional(
    Type.Integer({ minimum: 0, description: "Read or match output after this cursor" }),
  ),
  tailLines: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 2000,
      description: "Tail lines when no cursor is supplied",
    }),
  ),
  waitSeconds: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: 120,
      description: "Long-poll duration for logs or wait; wait defaults to configured maximum",
    }),
  ),
  force: Type.Optional(Type.Boolean({ description: "Force immediate process-tree termination" })),
});

export type BackgroundTaskToolInput = Static<typeof BackgroundTaskParameters>;
export type BackgroundTaskAction = (typeof BACKGROUND_TASK_ACTIONS)[number];
