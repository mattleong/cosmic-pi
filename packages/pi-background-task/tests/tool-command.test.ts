import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { formatBytes } from "pi-cosmic-core";
import { LogBuffer, readLogBuffer } from "../src/task/log-buffer.ts";
import { MAX_CONTRACT_LOG_OUTPUT_BYTES } from "../src/tools/contract-schema.ts";
import type { BackgroundTaskServiceContract } from "../src/task/service.ts";
import {
  backgroundLogLines,
  executeBackgroundTaskCommand,
  type BackgroundTaskToolDetails,
} from "../src/tools/command.ts";
import type { BackgroundTaskToolInput } from "../src/tools/schema.ts";
import { projectBackgroundTaskCompactSummary } from "../src/ui/compact-summary.ts";
import {
  provideTaskService,
  taskLogs,
  taskServiceDouble,
  taskStatus,
  taskStop,
  taskWait,
} from "./support/task-service-double.ts";

const execute = (
  input: Parameters<typeof executeBackgroundTaskCommand>[0],
  service: Partial<BackgroundTaskServiceContract>,
  maxTextBytes?: number,
) =>
  executeBackgroundTaskCommand(input, "/", maxTextBytes).pipe(
    provideTaskService(taskServiceDouble(service)),
  );

const bufferService = (buffer: LogBuffer): Partial<BackgroundTaskServiceContract> => ({
  logs: (request) => Effect.succeed(taskLogs(readLogBuffer("task-1", buffer, "running", request))),
});

// A logs result's text after its header and notice lines, exactly as returned.
const logBody = (text: string, details: Parameters<typeof backgroundLogLines>[1]) => {
  const headerLines =
    1 + Number(details.logs.droppedBytes > 0) + Number(details.truncation !== undefined);
  return text.split("\n").slice(headerLines).join("\n");
};

const summarize = (
  args: Partial<BackgroundTaskToolInput>,
  result: { readonly details: unknown } | undefined,
) => projectBackgroundTaskCompactSummary({ phase: "settled", args, result, isError: false });

describe("shared background task command", () => {
  it.effect("pages forward through retained output without losing or repeating any of it", () =>
    Effect.gen(function* () {
      const buffer = new LogBuffer();
      const lines = Array.from(
        { length: 3_000 },
        (_, index) => `line ${index + 1} ${"x".repeat(30)}`,
      );
      for (let index = 0; index < lines.length; index += 500)
        buffer.append("stdout", `${lines.slice(index, index + 500).join("\n")}\n`, index, 1 << 22);
      const service = bufferService(buffer);
      const pages: string[] = [];
      let cursor = 0;
      for (let page = 0; page < 20; page++) {
        const result = yield* execute(
          { action: "logs", id: "task-1", afterCursor: cursor },
          service,
        );
        expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
        if (result.details.action !== "logs") throw new Error("logs returned other details");
        const next = result.details.logs.nextCursor;
        expect(result.text.split("\n")[0]).toContain(`cursor=${next} `);
        pages.push(logBody(result.text, result.details));
        if (next === buffer.latestCursor) {
          expect(result.details).not.toHaveProperty("truncation");
          break;
        }
        expect(next).toBeGreaterThan(cursor);
        expect(result.details.truncation).toMatchObject({
          omitted: "later",
          resumeAfterCursor: next,
        });
        cursor = next;
      }
      expect(pages.length).toBeGreaterThan(1);
      expect(pages.join("")).toBe(`${lines.join("\n")}\n`);

      const { contract } = yield* execute(
        { action: "logs", id: "task-1", afterCursor: 0 },
        service,
      );
      expect(contract).toMatchObject({
        output: `${lines.join("\n")}\n`,
        truncated: false,
        nextCursor: buffer.latestCursor,
      });
    }),
  );

  it.effect("pages structured output the same way within its own larger bound", () =>
    Effect.gen(function* () {
      const buffer = new LogBuffer();
      const chunk = `${"z".repeat(3_999)}\n`;
      for (let index = 0; index < 400; index++) buffer.append("stdout", chunk, index, 1 << 22);
      const service = bufferService(buffer);
      const outputs: string[] = [];
      let cursor = 0;
      for (let page = 0; page < 5 && cursor < buffer.latestCursor; page++) {
        const { contract } = yield* execute(
          { action: "logs", id: "task-1", afterCursor: cursor },
          service,
        );
        if (contract.action !== "logs") throw new Error("logs returned another contract");
        expect(Buffer.byteLength(contract.output)).toBeLessThanOrEqual(
          MAX_CONTRACT_LOG_OUTPUT_BYTES,
        );
        expect(contract.truncated).toBe(contract.nextCursor < buffer.latestCursor);
        outputs.push(contract.output);
        cursor = contract.nextCursor;
      }
      expect(outputs).toHaveLength(2);
      expect(outputs.join("")).toBe(chunk.repeat(400));
    }),
  );

  it.effect("says how much earlier output a tail read leaves out and where to read it", () =>
    Effect.gen(function* () {
      const buffer = new LogBuffer();
      const lines = Array.from({ length: 300 }, (_, index) => `line ${index + 1}`);
      buffer.append("stdout", `${lines.join("\n")}\n`, 0, 1 << 20);
      const result = yield* execute({ action: "logs", id: "task-1" }, bufferService(buffer));
      if (result.details.action !== "logs") throw new Error("logs returned other details");
      const [header, notice] = result.text.split("\n");
      expect(header).toBe(`[task-1 state=running cursor=${buffer.latestCursor} earliest=0]`);
      const omitted = Buffer.byteLength(`${lines.slice(0, 100).join("\n")}\n`);
      expect(result.details.truncation).toEqual({
        omitted: "earlier",
        omittedBytes: omitted,
        resumeAfterCursor: 0,
      });
      expect(notice).toContain(formatBytes(omitted));
      expect(logBody(result.text, result.details)).toBe(`${lines.slice(100).join("\n")}\n`);
      expect(backgroundLogLines(result.text, result.details)).toEqual(lines.slice(100));
      // The structured result leaves out the same earlier output, and says so.
      expect(result.contract).toMatchObject({
        output: `${lines.slice(100).join("\n")}\n`,
        truncated: true,
      });

      const all = yield* execute(
        { action: "logs", id: "task-1", afterCursor: 0 },
        bufferService(buffer),
      );
      expect(all.details).not.toHaveProperty("truncation");
      expect(all.contract).toMatchObject({ output: `${lines.join("\n")}\n`, truncated: false });
    }),
  );

  it.effect("tells discarded output, which is gone, apart from output left for the next page", () =>
    Effect.gen(function* () {
      const buffer = new LogBuffer();
      for (let index = 0; index < 8; index++)
        buffer.append("stdout", `${String(index).repeat(3_000)}\n`, index, 4 * 3_097);
      const result = yield* execute(
        { action: "logs", id: "task-1", afterCursor: 0 },
        bufferService(buffer),
        8_000,
      );
      if (result.details.action !== "logs") throw new Error("logs returned other details");
      expect(result.details).toMatchObject({
        logs: { nextCursor: 6, earliestAvailableCursor: 4, droppedBytes: 4 * 3_001 },
        truncation: { omitted: "later", omittedBytes: 2 * 3_001, resumeAfterCursor: 6 },
      });
      // Each loss has its own line: what was discarded, then what the next page holds.
      const [header, loss, notice] = result.text.split("\n");
      expect(header).toBe("[task-1 state=running cursor=6 earliest=4]");
      expect(loss).toContain(formatBytes(4 * 3_001));
      expect(loss).not.toContain(formatBytes(2 * 3_001));
      expect(notice).toContain(formatBytes(2 * 3_001));
      expect(notice).not.toContain(formatBytes(4 * 3_001));
      expect(logBody(result.text, result.details)).toBe(
        `${"4".repeat(3_000)}\n${"5".repeat(3_000)}\n`,
      );
    }),
  );

  it.effect("labels every stderr line and never lets streams share a line", () =>
    Effect.gen(function* () {
      const buffer = new LogBuffer();
      for (const [stream, text] of [
        ["stdout", "building "],
        ["stderr", "warn: a\nwarn: b\nErr"],
        ["stderr", "or: boom\n"],
        ["stdout", "done\n"],
      ] as const)
        buffer.append(stream, text, 0, 1 << 20);
      const service = bufferService(buffer);
      const expected =
        "building \n[stderr] warn: a\n[stderr] warn: b\n[stderr] Error: boom\ndone\n";
      const result = yield* execute({ action: "logs", id: "task-1", afterCursor: 0 }, service);
      if (result.details.action !== "logs") throw new Error("logs returned other details");
      expect(logBody(result.text, result.details)).toBe(expected);
      expect(result.contract).toMatchObject({ output: expected });
      expect(backgroundLogLines(result.text, result.details)).toEqual(
        expected.slice(0, -1).split("\n"),
      );
    }),
  );

  it.effect("cuts only an event larger than a whole result, and says so", () =>
    Effect.gen(function* () {
      const event = {
        cursor: 1,
        stream: "stdout" as const,
        text: "y".repeat(2_000),
        timestamp: 1,
        bytes: 2_000,
      };
      const slice = {
        id: "task-1",
        state: "running" as const,
        nextCursor: 1,
        earliestAvailableCursor: 0,
        droppedBytes: 0,
        retainedBytes: 2_000,
        events: [event],
      };
      const result = yield* execute(
        { action: "logs", id: "task-1" },
        { logs: () => Effect.succeed(taskLogs(slice)) },
        700,
      );
      expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(700);
      if (result.details.action !== "logs") throw new Error("logs returned other details");
      const shown = logBody(result.text, result.details);
      expect(result.details.truncation?.cutBytes).toBe(event.bytes - Buffer.byteLength(shown));
      // A tail read keeps the newest part of the event.
      expect(shown.length).toBeGreaterThan(0);
      expect(event.text.endsWith(shown)).toBe(true);
    }),
  );

  it.effect("names the task whose logs were read", () =>
    Effect.gen(function* () {
      const slice = {
        id: "bg-1",
        state: "exited" as const,
        nextCursor: 0,
        earliestAvailableCursor: 0,
        droppedBytes: 0,
        retainedBytes: 0,
        events: [],
      };
      // The identity comes with the slice, so no separate status read can race it.
      const subject = (task: Parameters<typeof taskLogs>[1]) =>
        execute(
          { action: "logs", id: "bg-1" },
          { logs: () => Effect.succeed(taskLogs(slice, task)) },
        ).pipe(Effect.map((result) => summarize({ action: "logs", id: "bg-1" }, result)?.subject));
      expect(yield* subject({ name: "api server", command: "pnpm dev" })).toBe("api server");
      expect(yield* subject({ command: "pnpm build" })).toBe("pnpm build");
    }),
  );

  it.effect("keeps a failed task's cause in details, independent of the result text", () =>
    Effect.gen(function* () {
      const cause = "FAIL tests/auth.test.ts > adds";
      const failed = taskStatus({
        id: "bg-2",
        name: "tests",
        state: "failed",
        endedAt: 2,
        exitCode: 1,
        logCursor: 3,
        failureCause: cause,
      });
      const running = taskStatus({ id: "bg-3", name: "tests", state: "running", logCursor: 3 });
      const service = {
        status: () => Effect.succeed(failed),
        list: () => Effect.succeed([running, failed]),
      };
      const errorMessages = (
        args: Partial<BackgroundTaskToolInput>,
        details: BackgroundTaskToolDetails,
      ) =>
        (summarize(args, { details })?.issues ?? [])
          .filter((issue) => issue.severity === "error")
          .map((issue) => issue.message);
      for (const input of [{ action: "status", id: "bg-2" }, { action: "list" }] as const) {
        const result = yield* execute(input, service);
        expect(result.text).toContain(cause);
        const snapshots =
          "snapshot" in result.details
            ? [result.details.snapshot]
            : "tasks" in result.details
              ? result.details.tasks
              : [];
        expect(snapshots).toContainEqual(failed);
        const messages = errorMessages(input, result.details);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toContain(cause);
      }
      // A cut or hook-rewritten text must not change the cause the row shows.
      const cut = yield* execute({ action: "status", id: "bg-2" }, service, 30);
      expect(cut.text).not.toContain(cause);
      expect(errorMessages({ action: "status", id: "bg-2" }, cut.details)[0]).toContain(cause);
    }),
  );

  it.effect("redacts and bounds the cause it stores in details", () =>
    Effect.gen(function* () {
      const failed = taskStatus({
        id: "bg-2",
        state: "failed",
        endedAt: 2,
        exitCode: 1,
        failureCause: `FAIL token=cause-secret \u001b[31m${"x".repeat(5_000)}`,
      });
      const result = yield* execute(
        { action: "status", id: "bg-2" },
        { status: () => Effect.succeed(failed) },
      );
      const stored = "snapshot" in result.details ? result.details.snapshot.failureCause : "";
      expect(stored).toMatch(/^FAIL token=/u);
      expect(stored).not.toContain("cause-secret");
      expect(stored).not.toContain("\u001b");
      expect(stored?.length).toBeLessThanOrEqual(2_048);
      expect(result.text).not.toContain("cause-secret");
    }),
  );
});

const recordingService = () => {
  const calls: string[] = [];
  const record =
    <A>(method: string, value: A) =>
    () => {
      calls.push(method);
      return Effect.succeed(value);
    };
  const running = taskStatus({ id: "task-1", state: "running" });
  const service: Partial<BackgroundTaskServiceContract> = {
    start: record("start", running),
    list: record("list", [running]),
    status: record("status", running),
    logs: record(
      "logs",
      taskLogs({
        id: "task-1",
        state: "running" as const,
        nextCursor: 0,
        earliestAvailableCursor: 0,
        retainedBytes: 0,
        droppedBytes: 0,
        events: [],
      }),
    ),
    wait: record("wait", taskWait(running, "timeout")),
    stop: record("stop", taskStop({ ...running, state: "stopped" as const, endedAt: 2 })),
    stopAll: record("stopAll", [running]),
    clear: Effect.sync(() => {
      calls.push("clear");
      return 0;
    }),
  };
  return { calls, service };
};

describe("background task action parameters", () => {
  it.effect("rejects fields the action does not use before touching any task", () =>
    Effect.gen(function* () {
      const rejected: ReadonlyArray<readonly [BackgroundTaskToolInput, ReadonlyArray<string>]> = [
        [{ action: "stop_all", id: "task-1" }, ["id"]],
        [{ action: "clear", id: "task-1" }, ["id"]],
        [{ action: "clear", force: true }, ["force"]],
        [{ action: "wait", id: "task-1", until: "exit", timeoutSeconds: 600 }, ["timeoutSeconds"]],
        [
          { action: "logs", id: "task-1", until: "output", contains: "ready" },
          ["until", "contains"],
        ],
        [{ action: "list", state: "active", id: "task-1" }, ["id"]],
        [{ action: "status", id: "task-1", force: true }, ["force"]],
        [{ action: "start", command: "pnpm dev", waitSeconds: 5 }, ["waitSeconds"]],
        [{ action: "logs", id: "task-1", afterCursor: 3, tailLines: 20 }, ["afterCursor"]],
      ];
      for (const [input, fields] of rejected) {
        const { calls, service } = recordingService();
        const error = yield* Effect.flip(execute(input, service));
        expect(calls, input.action).toEqual([]);
        expect(error._tag).toBe("InvalidBackgroundCommandError");
        for (const name of [input.action, ...fields]) expect(error.message).toContain(name);
      }
    }),
  );

  it.effect("accepts every field an action uses", () =>
    Effect.gen(function* () {
      const accepted: ReadonlyArray<BackgroundTaskToolInput> = [
        { action: "start", command: "pnpm dev", cwd: ".", name: "dev", timeoutSeconds: 60 },
        { action: "list", state: "completed" },
        { action: "status", id: "task-1" },
        { action: "logs", id: "task-1", afterCursor: 2, waitSeconds: 5 },
        { action: "logs", id: "task-1", tailLines: 20 },
        { action: "wait", id: "task-1", until: "output", contains: "ready", afterCursor: 2 },
        { action: "wait", id: "task-1", until: "exit", waitSeconds: 10 },
        { action: "stop", id: "task-1", force: true },
        { action: "stop_all", force: true },
        { action: "clear" },
      ];
      for (const input of accepted) {
        const { calls, service } = recordingService();
        yield* execute(input, service);
        expect(calls.length, input.action).toBeGreaterThan(0);
      }
    }),
  );
});

describe("background task results", () => {
  it.effect("reports the applied wait limit and whether the setting capped it", () =>
    Effect.gen(function* () {
      const running = taskStatus({ id: "task-1", state: "running" });
      const waitFor = (waitSeconds: number | undefined, appliedWaitSeconds: number) =>
        execute(
          {
            action: "wait",
            id: "task-1",
            until: "exit",
            ...(waitSeconds !== undefined && { waitSeconds }),
          },
          { wait: () => Effect.succeed(taskWait(running, "timeout", { appliedWaitSeconds })) },
        );
      const capped = yield* waitFor(120, 30);
      const exact = yield* waitFor(10, 10);
      const defaulted = yield* waitFor(undefined, 30);
      expect(capped.contract).toMatchObject({ action: "wait", appliedWaitSeconds: 30 });
      expect(exact.contract).toMatchObject({ action: "wait", appliedWaitSeconds: 10 });
      expect(capped.details).toMatchObject({ appliedWaitSeconds: 30 });
      expect(capped.text).toContain("30");
      expect(capped.text).toContain("120");
      expect(exact.text).toContain("10");
      expect(defaulted.text).not.toBe(capped.text);
      expect(defaulted.text).toContain("30");
    }),
  );

  it.effect("does not report stopping a task that had already finished", () =>
    Effect.gen(function* () {
      // A task can finish after a status read but before its stop lands; only the stop knows.
      const finished = taskStatus({ id: "task-1", state: "exited", endedAt: 2, exitCode: 0 });
      const running = taskStatus({ id: "task-2", state: "running" });
      const stopped = { ...running, state: "stopped" as const, endedAt: 3, signal: "SIGTERM" };
      const noop = yield* execute(
        { action: "stop", id: "task-1" },
        { stop: () => Effect.succeed(taskStop(finished, true)) },
      );
      const real = yield* execute(
        { action: "stop", id: "task-2" },
        { stop: () => Effect.succeed(taskStop(stopped)) },
      );
      expect(noop.details).toMatchObject({ action: "stop", alreadyFinished: true });
      expect(real.details).toMatchObject({ action: "stop", alreadyFinished: false });
      expect(noop.contract).toMatchObject({
        action: "stop",
        alreadyFinished: true,
        task: { state: "exited" },
      });
      expect(real.contract).toMatchObject({ action: "stop", alreadyFinished: false });
      expect(noop.text.split(" ")[0]).not.toBe(real.text.split(" ")[0]);
      expect(summarize({ action: "stop", id: "task-1" }, noop)?.outcome).toBe("returned");
      expect(summarize({ action: "stop", id: "task-2" }, real)?.outcome).toBe("success");
    }),
  );

  it.effect("starts the command exactly as submitted and rejects a blank one", () =>
    Effect.gen(function* () {
      const submitted: string[] = [];
      const start: BackgroundTaskServiceContract["start"] = (request) => {
        submitted.push(request.command);
        return Effect.succeed(taskStatus({ id: "task-1", state: "running", ...request }));
      };
      const command = "printf '<%s>\\n' 'trailing'\\ ";
      const result = yield* execute({ action: "start", command, name: "  echo  " }, { start });
      expect(submitted).toEqual([command]);
      expect(result.details).toMatchObject({ snapshot: { command, name: "echo" } });

      const blank = yield* Effect.flip(execute({ action: "start", command: " \t\n" }, { start }));
      expect(blank._tag).toBe("InvalidBackgroundCommandError");
      expect(submitted).toEqual([command]);
    }),
  );

  it.effect("describes an empty list by the filter it applied", () =>
    Effect.gen(function* () {
      const empty = { list: () => Effect.succeed([]) };
      const texts = yield* Effect.forEach(["active", "completed", "all"] as const, (state) =>
        Effect.map(execute({ action: "list", state }, empty), (result) => result.text),
      );
      expect(new Set(texts).size).toBe(3);
      expect(texts[0]).toContain("active");
      expect(texts[1]).toContain("completed");
    }),
  );
});
