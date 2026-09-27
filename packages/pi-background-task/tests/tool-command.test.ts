import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { BackgroundTaskService } from "../src/task/service.ts";
import { executeBackgroundTaskCommand } from "../src/tools/command.ts";
import { projectBackgroundTaskCompactSummary } from "../src/ui/compact-summary.ts";

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
  it.effect("tells the agent how a task ended, including a spawn error and signal", () =>
    Effect.gen(function* () {
      const base = { command: "run", cwd: "/", startedAt: 1, logCursor: 0, droppedLogBytes: 0 };
      const tasks = {
        "bg-1": {
          ...base,
          id: "bg-1",
          state: "failed" as const,
          error: "Couldn't start the process",
        },
        "bg-2": {
          ...base,
          id: "bg-2",
          state: "failed" as const,
          exitCode: null,
          signal: "SIGKILL",
        },
      };
      for (const [id, task] of Object.entries(tasks)) {
        const result = yield* executeBackgroundTaskCommand({ action: "status", id }, "/").pipe(
          Effect.provideService(BackgroundTaskService, {
            ...service,
            status: () => Effect.succeed(task),
          }),
          Effect.provide(Path.layer),
        );
        if ("error" in task) expect(result.text).toContain(task.error);
        if ("signal" in task) expect(result.text).toContain(task.signal);
      }
    }),
  );

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

  it.effect("puts a failed task's cause in the text and only its span in details", () =>
    Effect.gen(function* () {
      const failed = {
        id: "bg-2",
        name: "tests",
        command: "pnpm test",
        cwd: "/",
        state: "failed" as const,
        startedAt: 1,
        endedAt: 2,
        exitCode: 1,
        logCursor: 3,
        droppedLogBytes: 0,
        failureCause: "FAIL tests/auth.test.ts > adds",
      };
      const { failureCause: _cause, ...persisted } = failed;
      const { exitCode: _exit, endedAt: _ended, ...base } = persisted;
      const running = { ...base, id: "bg-3", state: "running" as const };
      const statusService = {
        ...service,
        status: () => Effect.succeed(failed),
        list: () => Effect.succeed([running, failed]),
      };
      const run = (
        input: Parameters<typeof executeBackgroundTaskCommand>[0],
        maxTextBytes?: number,
      ) =>
        executeBackgroundTaskCommand(
          input,
          "/",
          maxTextBytes === undefined ? {} : { maxTextBytes },
        ).pipe(
          Effect.provideService(BackgroundTaskService, statusService),
          Effect.provide(Path.layer),
        );
      for (const input of [{ action: "status", id: "bg-2" }, { action: "list" }] as const) {
        const result = yield* run(input);
        expect(result.text).toContain("cause: FAIL tests/auth.test.ts > adds");
        // Details keep metadata only: the v1 snapshot and where the cause sits in the text.
        const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
          result.details,
        );
        expect(encoded).not.toContain("FAIL tests");
        const snapshots =
          "snapshot" in result.details
            ? [result.details.snapshot]
            : "tasks" in result.details
              ? result.details.tasks
              : [];
        expect(snapshots).toContainEqual(persisted);
        const spans = "causes" in result.details ? (result.details.causes ?? []) : [];
        expect(spans.map(({ id, start, end }) => [id, result.text.slice(start, end)])).toEqual([
          ["bg-2", "FAIL tests/auth.test.ts > adds"],
        ]);
        const summary = projectBackgroundTaskCompactSummary({
          phase: "settled",
          args: input,
          result: { details: result.details, text: result.text },
          isError: false,
        });
        expect(summary?.issues?.map((issue) => issue.message).join("\n")).toContain(
          "exited with code 1: FAIL tests/auth.test.ts > adds",
        );
      }
      // Text truncated before the cause drops its span; the row keeps the bare exit status.
      const cut = yield* run({ action: "status", id: "bg-2" }, 30);
      expect("causes" in cut.details && cut.details.causes).toBeFalsy();
      expect(
        projectBackgroundTaskCompactSummary({
          phase: "settled",
          args: { action: "status", id: "bg-2" },
          result: { details: cut.details, text: cut.text },
          isError: false,
        })?.issues?.[0]?.message,
      ).toBe("The task exited with code 1");
    }),
  );
});
