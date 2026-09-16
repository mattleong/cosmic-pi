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
});
