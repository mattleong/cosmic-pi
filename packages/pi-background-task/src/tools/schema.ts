import { StringEnum } from "@earendil-works/pi-ai";
import { toolArgumentPreparer } from "pi-cosmic-core/tool-arguments";
import { Type, type Static } from "typebox";
import { BACKGROUND_TASK_FIELD_BOUNDS } from "../task/bounds.ts";
import { BACKGROUND_TASK_ACTIONS, BACKGROUND_TASK_NOTIFY_FILTERS } from "../task/schema.ts";

export const BackgroundTaskParameters = Type.Object({
  action: StringEnum(BACKGROUND_TASK_ACTIONS, { description: "Background task operation" }),
  command: Type.Optional(
    Type.String({
      maxLength: BACKGROUND_TASK_FIELD_BOUNDS.maxCommandBytes,
      description: "Shell command for start, at most 64 KiB of UTF-8",
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
      minimum: 0,
      description: "Runtime limit in seconds for start; omitted means no timeout",
    }),
  ),
  notify: Type.Optional(
    StringEnum(BACKGROUND_TASK_NOTIFY_FILTERS, {
      description:
        'For start: message you when the task finishes ("exit") or only when it fails or times out ("failure"); omitted means no message',
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
    Type.Union(
      [
        Type.String({ maxLength: BACKGROUND_TASK_FIELD_BOUNDS.maxContainsChars }),
        Type.Array(Type.String({ maxLength: BACKGROUND_TASK_FIELD_BOUNDS.maxContainsChars }), {
          maxItems: BACKGROUND_TASK_FIELD_BOUNDS.maxContainsAlternatives,
        }),
      ],
      {
        description: `Literal text required for until="output", or up to ${BACKGROUND_TASK_FIELD_BOUNDS.maxContainsAlternatives} alternatives to match whichever appears first; invalid for until="exit".`,
      },
    ),
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
      minimum: 0,
      description: `Newest lines for logs, capped at ${BACKGROUND_TASK_FIELD_BOUNDS.maxTailLines}; 0 or omitted means 200; invalid with afterCursor`,
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

/**
 * Pi `prepareArguments` hook: drops null and blank optional fields and reports invalid ones.
 * Whitespace is literal text to match in `contains`, so only its empty placeholder is dropped.
 */
export const prepareBackgroundTaskArguments = toolArgumentPreparer(
  "background_task",
  BackgroundTaskParameters,
  { keepWhitespace: ["contains"] },
);
