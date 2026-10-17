import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { BackgroundTaskServiceContract } from "../src/task/service.ts";
import { backgroundLogLines, executeBackgroundTaskCommand } from "../src/tools/command.ts";
import { projectBackgroundTaskCompactSummary } from "../src/ui/compact-summary.ts";
import {
  provideTaskService,
  taskServiceDouble,
  taskStatus,
} from "./support/task-service-double.ts";

const execute = (
  input: Parameters<typeof executeBackgroundTaskCommand>[0],
  service: Partial<BackgroundTaskServiceContract>,
  maxTextBytes?: number,
) =>
  executeBackgroundTaskCommand(input, "/", maxTextBytes).pipe(
    provideTaskService(taskServiceDouble(service)),
  );

describe("shared background task command", () => {
  it.effect("keeps the newest log lines when the text is cut and persists only what it holds", () =>
    Effect.gen(function* () {
      const logs = { id: "bg-1", nextCursor: 2, earliestAvailableCursor: 1, droppedBytes: 0 };
      for (const [count, maxTextBytes] of [
        [20, 96],
        [DEFAULT_MAX_LINES + 100, DEFAULT_MAX_BYTES],
      ] as const) {
        const lines = Array.from({ length: count }, (_, index) => `line ${index + 1}`);
        const text = `${lines.join("\n")}\n`;
        const bytes = Buffer.byteLength(text);
        const event = { cursor: 1, stream: "stdout" as const, text, timestamp: 1, bytes };
        const slice = { ...logs, state: "running" as const, events: [event] };
        const result = yield* execute(
          { action: "logs", id: "bg-1" },
          { logs: () => Effect.succeed(slice) },
          maxTextBytes,
        );
        const kept = backgroundLogLines(result.text, logs);
        expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(maxTextBytes);
        expect(kept.length).toBeGreaterThan(0);
        expect(kept).toEqual(lines.slice(-kept.length));
        expect(result.details).toEqual({
          action: "logs",
          logs: { ...logs, state: "running" },
          truncation: {
            truncated: true,
            outputBytes: Buffer.byteLength(kept.join("\n")),
            totalBytes: bytes,
            outputLines: kept.length,
            totalLines: count,
          },
        });
      }
    }),
  );

  it.effect("puts a failed task's cause in the text and only its span in details", () =>
    Effect.gen(function* () {
      const failed = taskStatus({
        id: "bg-2",
        name: "tests",
        state: "failed",
        endedAt: 2,
        exitCode: 1,
        logCursor: 3,
        failureCause: "FAIL tests/auth.test.ts > adds",
      });
      const { failureCause: _cause, ...persisted } = failed;
      const running = taskStatus({ id: "bg-3", name: "tests", state: "running", logCursor: 3 });
      const service = {
        status: () => Effect.succeed(failed),
        list: () => Effect.succeed([running, failed]),
      };
      for (const input of [{ action: "status", id: "bg-2" }, { action: "list" }] as const) {
        const result = yield* execute(input, service);
        expect(result.text).toContain("cause: FAIL tests/auth.test.ts > adds");
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
          "code 1: FAIL tests/auth.test.ts > adds",
        );
      }
      const cut = yield* execute({ action: "status", id: "bg-2" }, service, 30);
      expect("causes" in cut.details && cut.details.causes).toBeFalsy();
      expect(
        projectBackgroundTaskCompactSummary({
          phase: "settled",
          args: { action: "status", id: "bg-2" },
          result: { details: cut.details, text: cut.text },
          isError: false,
        })?.issues?.[0]?.message,
      ).toMatch(/code 1$/u);
    }),
  );
});
