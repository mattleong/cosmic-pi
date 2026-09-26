import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { BackgroundTaskService } from "../src/task/service.ts";
import { executeBackgroundTaskCommand } from "../src/tools/command.ts";

const unexpected = () => Effect.die("Invalid wait reached the task service");
const service = {
  start: unexpected,
  list: unexpected,
  status: unexpected,
  logs: unexpected,
  wait: unexpected,
  stop: unexpected,
  stopAll: unexpected,
  clear: unexpected(),
};

describe("shared background task command", () => {
  it.effect("rejects a wait without until before acquiring a task waiter", () =>
    Effect.gen(function* () {
      const error = yield* executeBackgroundTaskCommand(
        { action: "wait", id: "bg-1" },
        "/project",
      ).pipe(
        Effect.provideService(BackgroundTaskService, service),
        Effect.provide(Path.layer),
        Effect.flip,
      );
      expect(error._tag).toBe("InvalidBackgroundCommandError");
    }),
  );

  it.effect("persists only log metadata and truncation fields, never log text", () =>
    Effect.gen(function* () {
      const logs = { id: "bg-1", nextCursor: 2, earliestAvailableCursor: 1, droppedBytes: 0 };
      const text = "private line\n".repeat(10);
      const event = { cursor: 1, stream: "stdout" as const, text, timestamp: 1, bytes: 130 };
      const slice = { ...logs, state: "running" as const, events: [event] };
      const result = yield* executeBackgroundTaskCommand({ action: "logs", id: "bg-1" }, "/", {
        maxTextBytes: 64,
      }).pipe(
        Effect.provideService(BackgroundTaskService, {
          ...service,
          logs: () => Effect.succeed(slice),
        }),
        Effect.provide(Path.layer),
      );
      expect(result.details).toEqual({
        action: "logs",
        logs: { ...logs, state: "running" },
        truncation: {
          truncated: true,
          outputBytes: expect.any(Number),
          totalBytes: 130,
          outputLines: expect.any(Number),
          totalLines: expect.any(Number),
        },
      });
    }),
  );
});
