import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { formatBytes } from "pi-cosmic-core";
import { LogBuffer, readLogBuffer } from "../src/task/log-buffer.ts";
import { MAX_CONTRACT_LOG_OUTPUT_BYTES } from "../src/tools/contract-schema.ts";
import type { BackgroundTaskServiceContract } from "../src/task/service.ts";
import {
  backgroundLogLines,
  executeBackgroundTaskCommand,
  type BackgroundTaskToolDetails,
} from "../src/tools/command.ts";
import {
  prepareBackgroundTaskArguments,
  type BackgroundTaskToolInput,
} from "../src/tools/schema.ts";
import { projectBackgroundTaskCompactSummary } from "../src/ui/compact-summary.ts";
import {
  provideTaskService,
  taskLogSlice,
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
  logs: (request) =>
    Effect.succeed(taskLogs(readLogBuffer("task-0000000001", buffer, "running", request))),
});

// A logs result's text after its header and notice lines, exactly as returned.
const logBody = (text: string, details: Parameters<typeof backgroundLogLines>[1]) => {
  const headerLines =
    1 + Number(details.logs.droppedBytes > 0) + Number(details.truncation !== undefined);
  return Arr.join(Str.split(text, "\n").slice(headerLines), "\n");
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
        (_, index) => `line ${index + 1} ${Fn.pipe("x", Str.repeat(30))}`,
      );
      for (let index = 0; index < lines.length; index += 500)
        buffer.append(
          "stdout",
          `${Arr.join(lines.slice(index, index + 500), "\n")}\n`,
          index,
          1 << 22,
        );
      const service = bufferService(buffer);
      const pages: string[] = [];
      let cursor = 0;
      for (let page = 0; page < 20; page++) {
        const result = yield* execute(
          { action: "logs", id: "task-0000000001", afterCursor: cursor },
          service,
        );
        expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
        if (result.details.action !== "logs") throw new Error("logs returned other details");
        const next = result.details.logs.nextCursor;
        expect(Str.split(result.text, "\n")[0]).toContain(`cursor=${next} `);
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
      expect(Arr.join(pages, "")).toBe(`${Arr.join(lines, "\n")}\n`);

      const { contract } = yield* execute(
        { action: "logs", id: "task-0000000001", afterCursor: 0 },
        service,
      );
      expect(contract).toMatchObject({
        output: `${Arr.join(lines, "\n")}\n`,
        truncated: false,
        nextCursor: buffer.latestCursor,
      });
    }),
  );

  it.effect("pages structured output the same way within its own larger bound", () =>
    Effect.gen(function* () {
      const buffer = new LogBuffer();
      const chunk = `${Fn.pipe("z", Str.repeat(3_999))}\n`;
      for (let index = 0; index < 400; index++) buffer.append("stdout", chunk, index, 1 << 22);
      const service = bufferService(buffer);
      const outputs: string[] = [];
      let cursor = 0;
      for (let page = 0; page < 5 && cursor < buffer.latestCursor; page++) {
        const { contract } = yield* execute(
          { action: "logs", id: "task-0000000001", afterCursor: cursor },
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
      expect(Arr.join(outputs, "")).toBe(Fn.pipe(chunk, Str.repeat(400)));
    }),
  );

  it.effect("says how much earlier output a tail read leaves out and where to read it", () =>
    Effect.gen(function* () {
      const buffer = new LogBuffer();
      const lines = Array.from({ length: 300 }, (_, index) => `line ${index + 1}`);
      buffer.append("stdout", `${Arr.join(lines, "\n")}\n`, 0, 1 << 20);
      const result = yield* execute(
        { action: "logs", id: "task-0000000001" },
        bufferService(buffer),
      );
      if (result.details.action !== "logs") throw new Error("logs returned other details");
      const [header, notice] = Str.split(result.text, "\n");
      expect(header).toBe(
        `[task-0000000001 state=running cursor=${buffer.latestCursor} earliest=0]`,
      );
      const omitted = Buffer.byteLength(`${Arr.join(lines.slice(0, 100), "\n")}\n`);
      expect(result.details.truncation).toEqual({
        omitted: "earlier",
        omittedBytes: omitted,
        resumeAfterCursor: 0,
      });
      expect(notice).toContain(formatBytes(omitted));
      expect(logBody(result.text, result.details)).toBe(`${Arr.join(lines.slice(100), "\n")}\n`);
      expect(backgroundLogLines(result.text, result.details)).toEqual(lines.slice(100));
      // The structured result leaves out the same earlier output, and says so.
      expect(result.contract).toMatchObject({
        output: `${Arr.join(lines.slice(100), "\n")}\n`,
        truncated: true,
      });

      const all = yield* execute(
        { action: "logs", id: "task-0000000001", afterCursor: 0 },
        bufferService(buffer),
      );
      expect(all.details).not.toHaveProperty("truncation");
      expect(all.contract).toMatchObject({
        output: `${Arr.join(lines, "\n")}\n`,
        truncated: false,
      });
    }),
  );

  it.effect("tells discarded output, which is gone, apart from output left for the next page", () =>
    Effect.gen(function* () {
      const buffer = new LogBuffer();
      for (let index = 0; index < 8; index++)
        buffer.append("stdout", `${Fn.pipe(String(index), Str.repeat(3_000))}\n`, index, 4 * 3_097);
      const result = yield* execute(
        { action: "logs", id: "task-0000000001", afterCursor: 0 },
        bufferService(buffer),
        8_000,
      );
      if (result.details.action !== "logs") throw new Error("logs returned other details");
      expect(result.details).toMatchObject({
        logs: { nextCursor: 6, earliestAvailableCursor: 4, droppedBytes: 4 * 3_001 },
        truncation: { omitted: "later", omittedBytes: 2 * 3_001, resumeAfterCursor: 6 },
      });
      // Each loss has its own line: what was discarded, then what the next page holds.
      const [header, loss, notice] = Str.split(result.text, "\n");
      expect(header).toBe("[task-0000000001 state=running cursor=6 earliest=4]");
      expect(loss).toContain(formatBytes(4 * 3_001));
      expect(loss).not.toContain(formatBytes(2 * 3_001));
      expect(notice).toContain(formatBytes(2 * 3_001));
      expect(notice).not.toContain(formatBytes(4 * 3_001));
      expect(logBody(result.text, result.details)).toBe(
        `${Fn.pipe("4", Str.repeat(3_000))}\n${Fn.pipe("5", Str.repeat(3_000))}\n`,
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
      const result = yield* execute(
        { action: "logs", id: "task-0000000001", afterCursor: 0 },
        service,
      );
      if (result.details.action !== "logs") throw new Error("logs returned other details");
      expect(logBody(result.text, result.details)).toBe(expected);
      expect(result.contract).toMatchObject({ output: expected });
      expect(backgroundLogLines(result.text, result.details)).toEqual(
        Str.split(Fn.pipe(expected, Str.slice(0, -1)), "\n"),
      );
    }),
  );

  it.effect("cuts only an event larger than a whole result, and says so", () =>
    Effect.gen(function* () {
      const event = {
        cursor: 1,
        stream: "stdout" as const,
        text: Fn.pipe("y", Str.repeat(2_000)),
        timestamp: 1,
        bytes: 2_000,
      };
      const slice = {
        id: "task-0000000001",
        state: "running" as const,
        nextCursor: 1,
        earliestAvailableCursor: 0,
        droppedBytes: 0,
        retainedBytes: 2_000,
        events: [event],
      };
      const result = yield* execute(
        { action: "logs", id: "task-0000000001" },
        { logs: () => Effect.succeed(taskLogs(slice)) },
        700,
      );
      expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(700);
      if (result.details.action !== "logs") throw new Error("logs returned other details");
      const shown = logBody(result.text, result.details);
      expect(result.details.truncation?.cutBytes).toBe(event.bytes - Buffer.byteLength(shown));
      // A tail read keeps the newest part of the event.
      expect(shown.length).toBeGreaterThan(0);
      expect(Fn.pipe(event.text, Str.endsWith(shown))).toBe(true);
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
        Arr.map(
          Arr.filter(
            summarize(args, { details })?.issues ?? [],
            (issue) => issue.severity === "error",
          ),
          (issue) => issue.message,
        );
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
        failureCause: `FAIL token=cause-secret \u001b[31m${Fn.pipe("x", Str.repeat(5_000))}`,
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
  const requests: unknown[] = [];
  const record =
    <A>(method: string, value: A) =>
    (...args: ReadonlyArray<unknown>) => {
      calls.push(method);
      requests.push(...args);
      return Effect.succeed(value);
    };
  const running = taskStatus({ id: "task-0000000001", state: "running" });
  const service: Partial<BackgroundTaskServiceContract> = {
    start: record("start", running),
    list: record("list", [running]),
    status: record("status", running),
    logs: record(
      "logs",
      taskLogs({
        id: "task-0000000001",
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
  return { calls, requests, service };
};

describe("background task action parameters", () => {
  it.effect("rejects fields the action does not use before touching any task", () =>
    Effect.gen(function* () {
      const rejected: ReadonlyArray<readonly [BackgroundTaskToolInput, ReadonlyArray<string>]> = [
        [{ action: "stop_all", id: "task-0000000001" }, ["id"]],
        [{ action: "clear", id: "task-0000000001" }, ["id"]],
        [{ action: "clear", force: true }, ["force"]],
        [
          { action: "wait", id: "task-0000000001", until: "exit", timeoutSeconds: 600 },
          ["timeoutSeconds"],
        ],
        [
          { action: "logs", id: "task-0000000001", until: "output", contains: "ready" },
          ["until", "contains"],
        ],
        [{ action: "list", state: "active", id: "task-0000000001" }, ["id"]],
        [{ action: "status", id: "task-0000000001", force: true }, ["force"]],
        [{ action: "start", command: "pnpm dev", waitSeconds: 5 }, ["waitSeconds"]],
        [{ action: "status", id: "task-0000000001", notify: "exit" }, ["notify"]],
        [{ action: "logs", id: "task-0000000001", afterCursor: 3, tailLines: 20 }, ["afterCursor"]],
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
        { action: "start", command: "pnpm test", notify: "failure" },
        { action: "list", state: "completed" },
        { action: "status", id: "task-0000000001" },
        { action: "logs", id: "task-0000000001", afterCursor: 2, waitSeconds: 5 },
        { action: "logs", id: "task-0000000001", tailLines: 20 },
        {
          action: "wait",
          id: "task-0000000001",
          until: "output",
          contains: "ready",
          afterCursor: 2,
        },
        { action: "wait", id: "task-0000000001", until: "output", contains: ["ready", "failed"] },
        { action: "wait", id: "task-0000000001", until: "exit", waitSeconds: 10 },
        { action: "stop", id: "task-0000000001", force: true },
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

describe("background task argument leniency", () => {
  it.effect("ignores placeholders in fields the action does not use", () =>
    Effect.gen(function* () {
      // Each call reaches the service with only the arguments its action uses.
      const lenient: ReadonlyArray<readonly [BackgroundTaskToolInput, ReadonlyArray<unknown>]> = [
        [{ action: "stop_all", id: "", force: false, tailLines: 0 }, [false, "agent"]],
        [{ action: "clear", id: " ", force: false, waitSeconds: 0, command: "" }, []],
        [
          { action: "start", command: "pnpm dev", afterCursor: 0, waitSeconds: 0, force: false },
          [{ command: "pnpm dev", cwd: "/" }],
        ],
        [
          {
            action: "wait",
            id: "task-0000000001",
            until: "exit",
            contains: "",
            afterCursor: 0,
            cwd: "",
          },
          [{ id: "task-0000000001", until: "exit" }],
        ],
        [
          { action: "wait", id: "task-0000000001", until: "exit", contains: [" ", ""] },
          [{ id: "task-0000000001", until: "exit" }],
        ],
        [
          { action: "wait", id: "task-0000000001", until: "output", contains: ["ready", ""] },
          [{ id: "task-0000000001", until: "output", contains: ["ready"] }],
        ],
        [
          {
            action: "logs",
            id: "task-0000000001",
            afterCursor: 3,
            tailLines: 0,
            timeoutSeconds: 0,
          },
          [{ id: "task-0000000001", afterCursor: 3 }],
        ],
      ];
      for (const [input, expected] of lenient) {
        const { calls, requests, service } = recordingService();
        yield* execute(input, service);
        expect(calls, input.action).toHaveLength(1);
        expect(requests, input.action).toEqual(expected);
      }
    }),
  );

  it("drops null and blank optional arguments before validation", () => {
    expect(
      prepareBackgroundTaskArguments({
        action: "stop_all",
        id: null,
        name: "  ",
        cwd: "",
        force: false,
      }),
    ).toEqual({ action: "stop_all", force: false });
    expect(
      prepareBackgroundTaskArguments({ action: "start", command: "make", contains: "" }),
    ).toEqual({ action: "start", command: "make" });
  });

  it("keeps whitespace-only text to match in contains", () => {
    for (const contains of [" ", "\n"])
      expect(
        prepareBackgroundTaskArguments({
          action: "wait",
          id: "task-0000000001",
          until: "output",
          contains,
        }),
      ).toEqual({ action: "wait", id: "task-0000000001", until: "output", contains });
  });

  it("accepts contains as one text or a few alternatives", () => {
    const wait = { action: "wait", id: "task-0000000001", until: "output" } as const;
    for (const contains of ["ready", ["ready", " ", "failed"]])
      expect(prepareBackgroundTaskArguments({ ...wait, contains })).toEqual({ ...wait, contains });
    expect(() =>
      prepareBackgroundTaskArguments({
        ...wait,
        contains: Array.from({ length: 9 }, (_, index) => `ready ${index}`),
      }),
    ).toThrow(/contains/u);
  });

  it("names the invalid field and its allowed values", () => {
    expect(() => prepareBackgroundTaskArguments({ action: "launch", command: "make" })).toThrow(
      /action[\s\S]*start/u,
    );
    expect(() => prepareBackgroundTaskArguments({ action: null })).toThrow(/action/u);
  });
});

describe("background task results", () => {
  it.effect("reports the applied wait limit and whether the setting capped it", () =>
    Effect.gen(function* () {
      const running = taskStatus({ id: "task-0000000001", state: "running" });
      const waitFor = (waitSeconds: number | undefined, appliedWaitSeconds: number) =>
        execute(
          {
            action: "wait",
            id: "task-0000000001",
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

  it.effect("reports what an output wait found with the task's recent output", () =>
    Effect.gen(function* () {
      const running = taskStatus({ id: "task-0000000001", state: "running", logCursor: 2 });
      const requests: Array<Parameters<BackgroundTaskServiceContract["wait"]>[0]> = [];
      const found = {
        matchCursor: 1,
        matchedText: "ready in",
        matchedLine: "VITE ready in 312 ms",
        recent: taskLogSlice(running.id, "running", [
          { stream: "stdout", text: "  VITE ready in 312 ms\n" },
          { stream: "stdout", text: "  Local: http://localhost:5173/\n" },
        ]),
      };
      const result = yield* execute(
        { action: "wait", id: running.id, until: "output", contains: ["error", "ready in"] },
        {
          wait: (request) => {
            requests.push(request);
            return Effect.succeed(taskWait(running, "matched", found));
          },
        },
      );
      expect(requests).toMatchObject([{ contains: ["error", "ready in"] }]);
      for (const text of ["VITE ready in 312 ms", "http://localhost:5173/"])
        expect(result.text).toContain(text);
      const reported = { matchedText: "ready in", matchedLine: "VITE ready in 312 ms" };
      expect(result.details).toMatchObject({ action: "wait", wait: reported });
      expect(result.contract).toMatchObject({ action: "wait", ...reported });
      if (result.details.action !== "wait" || result.contract.action !== "wait")
        throw new Error("wait returned another action");
      for (const tail of [result.details.wait.tail, result.contract.tail])
        expect(tail).toContain("Local: http://localhost:5173/");
    }),
  );

  it.effect("says when an output wait ended because its task finished first", () =>
    Effect.gen(function* () {
      const failed = taskStatus({
        id: "task-0000000001",
        state: "failed",
        endedAt: 2,
        exitCode: 1,
      });
      const args = { action: "wait", id: failed.id, until: "output", contains: "ready" } as const;
      const result = yield* execute(args, {
        wait: () =>
          Effect.succeed(
            taskWait(failed, "completed", {
              recent: taskLogSlice(failed.id, "failed", [
                { stream: "stderr", text: "Error: port in use\n" },
              ]),
            }),
          ),
      });
      expect(result.text).toContain("Error: port in use");
      expect(result.contract).toMatchObject({ outcome: "completed", task: { exitCode: 1 } });
      expect(result.contract).not.toHaveProperty("matchedText");
      const issues = summarize(args, result)?.issues ?? [];
      expect(Arr.map(issues, (issue) => issue.code)).toContain("task-0000000001:output-missing");
    }),
  );

  it.effect("does not report stopping a task that had already finished", () =>
    Effect.gen(function* () {
      // A task can finish after a status read but before its stop lands; only the stop knows.
      const finished = taskStatus({
        id: "task-0000000001",
        state: "exited",
        endedAt: 2,
        exitCode: 0,
      });
      const running = taskStatus({ id: "task-0000000002", state: "running" });
      const stopped = { ...running, state: "stopped" as const, endedAt: 3, signal: "SIGTERM" };
      const noop = yield* execute(
        { action: "stop", id: "task-0000000001" },
        { stop: () => Effect.succeed(taskStop(finished, true)) },
      );
      const real = yield* execute(
        { action: "stop", id: "task-0000000002" },
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
      expect(Str.split(noop.text, " ")[0]).not.toBe(Str.split(real.text, " ")[0]);
      expect(summarize({ action: "stop", id: "task-0000000001" }, noop)?.outcome).toBe("returned");
      expect(summarize({ action: "stop", id: "task-0000000002" }, real)?.outcome).toBe("success");
    }),
  );

  it.effect("starts the command exactly as submitted and rejects a blank one", () =>
    Effect.gen(function* () {
      const submitted: string[] = [];
      const start: BackgroundTaskServiceContract["start"] = (request) => {
        submitted.push(request.command);
        return Effect.succeed(taskStatus({ id: "task-0000000001", state: "running", ...request }));
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
