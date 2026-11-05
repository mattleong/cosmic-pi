import { homedir } from "node:os";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import {
  applyPresentationSettings,
  captureRegistrations,
  galleryDirectory,
  galleryFrames,
  galleryMessageFrames,
  galleryTranscriptFrames,
  withPresentationSettings,
  writeGallerySection,
  type GalleryMessageScenario,
  type GalleryScenario,
} from "pi-code-previews/testing";
import { deferredPromise, extensionContextFixture, macrotask } from "pi-cosmic-core/testing";
import { fakeCustomSurfaceHost } from "pi-cosmic-ui/testing";
import {
  KeybindingsManager as TuiKeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import { DEFAULT_BACKGROUND_TASK_CONFIG } from "../src/config/schema.ts";
import { BackgroundTaskConfigError } from "../src/config/store.ts";
import { taskSettingsSubcommand } from "../src/settings/task-settings.ts";
import { beforeAll, describe, it } from "@effect/vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  afterCursorAhead,
  BackgroundTaskCapacityError,
  BackgroundTerminationError,
  backgroundTaskNotFound,
  InvalidBackgroundCwdError,
} from "../src/task/errors.ts";
import type { BackgroundLogEvent, BackgroundTaskStatus } from "../src/task/model.ts";
import type { BackgroundTaskServiceContract } from "../src/task/service.ts";
import { taskNoticeMessage } from "../src/boundary/host-notice.ts";
import { TASK_NOTICE_MESSAGE_TYPE } from "../src/task/notice.ts";
import { registerBackgroundTaskTool } from "../src/tools/background-task.ts";
import { backgroundTaskFailure, executeBackgroundTaskCommand } from "../src/tools/command.ts";
import { renderTaskNotice } from "../src/ui/notice-message.ts";
import {
  backgroundTaskActivityDetail,
  backgroundTaskActivityItems,
} from "../src/boundary/host-activity.ts";
import { activityGalleryFrames } from "pi-cosmic-ui/activity/testing";
import type { BackgroundTaskToolInput } from "../src/tools/schema.ts";
import {
  provideTaskService,
  registeredTaskTool,
  taskLogSlice as slice,
  taskServiceDouble,
  taskStatus,
  taskStop,
  taskWait,
} from "./support/task-service-double.ts";

const task = (fields: Parameters<typeof taskStatus>[0]) => taskStatus({ logCursor: 12, ...fields });
const failed = task({
  id: "task-0000000001",
  name: "tests",
  state: "failed",
  endedAt: 42_001,
  exitCode: 1,
  failureCause: "FAIL tests/auth.test.ts > rejects expired tokens",
});
const killed = task({
  id: "task-0000000002",
  name: "build",
  command: "pnpm build",
  state: "failed",
  endedAt: 42_001,
  exitCode: 137,
});
const running = task({
  id: "task-0000000003",
  name: "server",
  command: "pnpm dev",
  state: "running",
  pid: 48213,
});
const stopping = task({
  id: "task-0000000004",
  name: "e2e",
  command: "pnpm test:e2e",
  state: "stopping",
  pid: 48377,
});
const timedOut = task({
  id: "task-0000000005",
  name: "migrate",
  command: "pnpm db:migrate",
  state: "timed_out",
  startedAt: 1_000,
  endedAt: 301_400,
  exitCode: null,
  signal: "SIGTERM",
});
const exitUnknown = task({
  id: "task-0000000006",
  name: "lint",
  command: "pnpm lint",
  state: "exited",
  endedAt: 42_001,
  exitCode: null,
});
const spawnFailed = task({
  id: "task-0000000007",
  name: "deploy",
  command: "./scripts/deploy.sh",
  state: "failed",
  endedAt: 42_001,
  logCursor: 0,
  error: "Couldn't start the process",
});
const finished = task({
  id: "task-0000000008",
  name: "typecheck",
  command: "pnpm typecheck",
  state: "exited",
  endedAt: 42_001,
  exitCode: 0,
});
const stoppedServer: BackgroundTaskStatus = {
  ...running,
  state: "stopped",
  endedAt: 42_001,
  exitCode: null,
  signal: "SIGTERM",
};
const noisy = task({
  id: "task-0000000009",
  name: "watch",
  command: "pnpm build --watch",
  state: "running",
  pid: 48455,
  logCursor: 230,
  droppedLogBytes: 18_432,
});
const stoppedWatcher: BackgroundTaskStatus = {
  ...noisy,
  state: "stopped",
  endedAt: 42_001,
  exitCode: null,
  signal: "SIGTERM",
};
const unnamed = task({
  id: "task-0000000012",
  command: "node scripts/seed.js --fixtures=large",
  state: "failed",
  endedAt: 42_001,
  exitCode: 127,
});
// Longer than any heading shows on one row: expansion must keep its last flag.
const verifyCommand = `node scripts/verify.ts ${Arr.join(
  Arr.makeBy(20, (index) => `--include=package-${index}`),
  " ",
)} --security-check`;
const longUnnamed = task({
  id: "task-0000000018",
  command: verifyCommand,
  state: "exited",
  endedAt: 42_001,
  exitCode: 0,
});
const errorNamed = task({
  id: "task-0000000014",
  name: "BuildError",
  command: "pnpm build:errors",
  state: "failed",
  endedAt: 42_001,
  exitCode: 2,
  failureCause: "src/index.ts:4 Cannot find name 'foo'",
});
const byId = new Map(
  Arr.map(
    [
      failed,
      killed,
      running,
      stopping,
      timedOut,
      exitUnknown,
      spawnFailed,
      finished,
      noisy,
      unnamed,
      longUnnamed,
    ],
    (entry) => [entry.id, entry],
  ),
);

type Line = Pick<BackgroundLogEvent, "stream" | "text">;
const out = (text: string): Line => ({ stream: "stdout", text: `${text}\n` });
const err = (text: string): Line => ({ stream: "stderr", text: `${text}\n` });

const service: Partial<BackgroundTaskServiceContract> = {
  list: () => Effect.succeed([running, failed, killed]),
  status: (id) => {
    const found = byId.get(id);
    return found ? Effect.succeed(found) : Effect.fail(backgroundTaskNotFound(id));
  },
};

const started =
  (id: string, pid: number): BackgroundTaskServiceContract["start"] =>
  (request) =>
    Effect.succeed(
      taskStatus({
        id,
        command: request.command,
        cwd: request.cwd,
        ...(request.name && { name: request.name }),
        state: "running",
        pid,
      }),
    );

interface Scenario {
  readonly title: string;
  readonly input: BackgroundTaskToolInput;
  readonly service?: Partial<BackgroundTaskServiceContract>;
  readonly phase?: "pending" | "running";
}

const serverLog = [
  out("  VITE v6.3.5  ready in 412 ms"),
  out("  ➜  Local:   http://localhost:5173/"),
  err("(!) Could not auto-determine entry point from rollupOptions"),
];
const requestLog = Array.from({ length: 30 }, (_, index) =>
  out(`GET /api/items/${index + 1} 200 ${12 + (index % 7)}ms`),
);
const bundleLog = [
  out("vite v6.3.5 building for production..."),
  out(`!function(){${Fn.pipe("var a=1;", Str.repeat(8_000))}}();`),
  out("✓ built in 3.21s"),
];
const testLog = [
  out(" ✓ tests/session.test.ts (4 tests) 18ms"),
  out(" ✗ tests/auth.test.ts (2 tests | 1 failed) 22ms"),
  err(" FAIL tests/auth.test.ts > rejects expired tokens"),
  err("AssertionError: expected 200 to be 401"),
];

const scenarios: ReadonlyArray<Scenario> = [
  {
    title: "start awaiting execution",
    input: { action: "start", command: "pnpm docs:dev", name: "docs" },
    phase: "pending",
  },
  {
    title: "started a named task",
    input: { action: "start", command: "pnpm docs:dev", name: "docs" },
    service: { start: started("task-0000000010", 48590) },
  },
  {
    title: "started a task that reports when it finishes",
    input: { action: "start", command: "pnpm test", name: "tests", notify: "exit" },
    service: { start: started("task-0000000015", 48633) },
  },
  {
    title: "started an unnamed task in a subdirectory",
    input: {
      action: "start",
      command: "pnpm vitest --watch --reporter=dot tests/task-service.test.ts",
      cwd: "packages/pi-background-task",
    },
    service: { start: started("task-0000000011", 48612) },
  },
  {
    title: "started an unnamed task with a 449-character command",
    input: { action: "start", command: verifyCommand },
    service: { start: started("task-0000000018", 48655) },
  },
  {
    // A working directory reads home-relative, as `~/web`.
    title: "started a task in a folder under home",
    input: { action: "start", command: "pnpm dev", name: "web", cwd: `${homedir()}/web` },
    service: { start: started("task-0000000016", 48650) },
  },
  {
    title: "start in a missing directory",
    input: { action: "start", command: "pnpm dev", cwd: "apps/missing" },
    service: {
      start: (request) =>
        Effect.fail(
          InvalidBackgroundCwdError.make({
            cwd: request.cwd,
            message: `Couldn't find the working directory ${request.cwd}`,
          }),
        ),
    },
  },
  { title: "running task", input: { action: "status", id: "task-0000000003" } },
  {
    title: "unnamed task with a 449-character command",
    input: { action: "status", id: "task-0000000018" },
  },
  { title: "finished task", input: { action: "status", id: "task-0000000008" } },
  { title: "failed task with a cause", input: { action: "status", id: "task-0000000001" } },
  { title: "task killed without output", input: { action: "status", id: "task-0000000002" } },
  { title: "task still stopping", input: { action: "status", id: "task-0000000004" } },
  { title: "task timed out", input: { action: "status", id: "task-0000000005" } },
  { title: "task exited with an unknown code", input: { action: "status", id: "task-0000000006" } },
  { title: "task that failed to spawn", input: { action: "status", id: "task-0000000007" } },
  { title: "task that lost output", input: { action: "status", id: "task-0000000009" } },
  {
    title: "unnamed task whose command was not found",
    input: { action: "status", id: "task-0000000012" },
  },
  { title: "status of an unknown task", input: { action: "status", id: "task-0000000042" } },
  {
    title: "short log slice",
    input: { action: "logs", id: "task-0000000003", tailLines: 5 },
    service: {
      logs: () =>
        Effect.succeed(slice("task-0000000003", "running", serverLog, { from: 9, task: running })),
    },
  },
  {
    title: "long log slice",
    input: { action: "logs", id: "task-0000000003", tailLines: 30 },
    service: {
      logs: () =>
        Effect.succeed(
          slice("task-0000000003", "running", requestLog, { from: 40, task: running }),
        ),
    },
  },
  {
    title: "logs after output was discarded",
    input: { action: "logs", id: "task-0000000003", afterCursor: 4 },
    service: {
      logs: () =>
        Effect.succeed(
          slice("task-0000000003", "running", requestLog.slice(0, 3), {
            from: 212,
            droppedBytes: 18_432,
            discardedBefore: { bytes: 18_432 },
            task: running,
          }),
        ),
    },
  },
  {
    title: "tail read that leaves earlier output out",
    input: { action: "logs", id: "task-0000000009", tailLines: 3 },
    service: {
      logs: () =>
        Effect.succeed(
          slice("task-0000000009", "running", bundleLog, {
            from: 7,
            droppedBytes: 18_432,
            task: noisy,
          }),
        ),
    },
  },
  {
    title: "log page with more output to read",
    input: { action: "logs", id: "task-0000000009", afterCursor: 6 },
    service: {
      logs: () =>
        Effect.succeed(slice("task-0000000009", "running", bundleLog, { from: 7, task: noisy })),
    },
  },
  {
    title: "logs of a failed task",
    input: { action: "logs", id: "task-0000000001", tailLines: 4 },
    service: {
      logs: () =>
        Effect.succeed(slice("task-0000000001", "failed", testLog, { from: 9, task: failed })),
    },
  },
  {
    title: "logs with no new output",
    input: { action: "logs", id: "task-0000000003", afterCursor: 11, waitSeconds: 5 },
    service: {
      logs: () =>
        Effect.succeed(slice("task-0000000003", "running", [], { from: 12, task: running })),
    },
  },
  {
    title: "logs from a cursor ahead of the task's output",
    input: { action: "logs", id: "task-0000000003", afterCursor: 40 },
    service: { logs: () => Effect.fail(afterCursorAhead("task-0000000003", 40, 12)) },
  },
  {
    title: "wait in progress",
    input: { action: "wait", id: "task-0000000003", until: "exit" },
    phase: "running",
  },
  {
    title: "wait matched output",
    input: { action: "wait", id: "task-0000000003", until: "output", contains: "ready in" },
    service: { wait: () => Effect.succeed(taskWait(running, "matched", { matchCursor: 9 })) },
  },
  {
    title: "wait matched one of several alternatives",
    input: {
      action: "wait",
      id: "task-0000000003",
      until: "output",
      contains: ["error", "EADDRINUSE", "Local:"],
    },
    service: {
      wait: () =>
        Effect.succeed(
          taskWait(running, "matched", {
            matchCursor: 10,
            matchedText: "Local:",
            matchedLine: "➜ Local: http://localhost:5173/",
            recent: slice("task-0000000003", "running", serverLog, { from: 9 }),
          }),
        ),
    },
  },
  {
    title: "wait completed",
    input: { action: "wait", id: "task-0000000008", until: "exit" },
    service: { wait: () => Effect.succeed(taskWait(finished, "completed")) },
  },
  {
    title: "wait completed with more output than its collapsed tail",
    input: { action: "wait", id: "task-0000000008", until: "exit" },
    service: {
      wait: () =>
        Effect.succeed(
          taskWait(finished, "completed", {
            recent: slice("task-0000000008", "exited", requestLog.slice(0, 10), { from: 0 }),
          }),
        ),
    },
  },
  {
    title: "wait completed with a failure",
    input: { action: "wait", id: "task-0000000001", until: "exit" },
    service: {
      wait: () =>
        Effect.succeed(
          taskWait(failed, "completed", {
            recent: slice("task-0000000001", "failed", testLog, { from: 9 }),
          }),
        ),
    },
  },
  {
    title: "output wait whose task exited without the awaited text",
    input: { action: "wait", id: "task-0000000003", until: "output", contains: "ready in" },
    service: {
      wait: () =>
        Effect.succeed(
          taskWait({ ...running, state: "failed", endedAt: 42_001, exitCode: 1 }, "completed", {
            recent: slice(
              "task-0000000003",
              "failed",
              [
                out("  VITE v6.3.5"),
                err("error when starting dev server:"),
                err("Error: listen EADDRINUSE: address already in use :::5173"),
              ],
              { from: 4 },
            ),
          }),
        ),
    },
  },
  {
    title: "wait timed out",
    input: { action: "wait", id: "task-0000000003", until: "exit", waitSeconds: 30 },
    service: { wait: () => Effect.succeed(taskWait(running, "timeout")) },
  },
  {
    title: "wait capped by the maxWaitSeconds setting",
    input: {
      action: "wait",
      id: "task-0000000003",
      until: "output",
      contains: "ready",
      waitSeconds: 120,
    },
    service: { wait: () => Effect.succeed(taskWait(running, "timeout")) },
  },
  {
    title: "output wait whose cursor fell behind discarded output",
    input: {
      action: "wait",
      id: "task-0000000009",
      until: "output",
      contains: "built in",
      afterCursor: 40,
    },
    service: {
      wait: () =>
        Effect.succeed(
          taskWait(noisy, "timeout", {
            earliestAvailableCursor: 212,
            droppedBytes: 18_432,
            skipped: { bytes: 18_432 },
          }),
        ),
    },
  },
  {
    title: "stop",
    input: { action: "stop", id: "task-0000000003" },
    service: { stop: () => Effect.succeed(taskStop(stoppedServer)) },
  },
  {
    title: "stop of a task that already finished",
    input: { action: "stop", id: "task-0000000008" },
    service: { stop: () => Effect.succeed(taskStop(finished, true)) },
  },
  {
    title: "stop all with a task ID it does not accept",
    input: { action: "stop_all", id: "task-0000000003" },
  },
  {
    title: "stop all",
    input: { action: "stop_all" },
    service: { stopAll: () => Effect.succeed([stoppedServer, stoppedWatcher]) },
  },
  {
    title: "stop all with nothing running",
    input: { action: "stop_all" },
    service: { stopAll: () => Effect.succeed([]) },
  },
  { title: "list with failures", input: { action: "list" } },
  {
    title: "list with a task named like an error",
    input: { action: "list", state: "completed" },
    service: { list: () => Effect.succeed([errorNamed, finished]) },
  },
  {
    title: "list whose rows wrap between whole facts",
    input: { action: "list" },
    service: {
      list: () =>
        Effect.succeed([
          { ...timedOut, command: "pnpm db:migrate --schema=packages/api/prisma/schema.prisma" },
          running,
        ]),
    },
  },
  {
    title: "list of many tasks",
    input: { action: "list", state: "all" },
    service: {
      list: () =>
        Effect.succeed([
          running,
          noisy,
          stopping,
          failed,
          killed,
          timedOut,
          exitUnknown,
          spawnFailed,
          finished,
          unnamed,
        ]),
    },
  },
  {
    title: "stop that could not confirm cleanup",
    input: { action: "stop", id: "task-0000000004", force: true },
    service: { stop: () => Effect.succeed(taskStop(stopping)) },
  },
  {
    title: "stop whose exit was never confirmed",
    input: { action: "stop", id: "task-0000000004", force: true },
    service: {
      stop: (id) =>
        Effect.fail(
          BackgroundTerminationError.make({
            id,
            message: "Background process did not confirm exit after forced termination.",
          }),
        ),
    },
  },
  {
    title: "start with every task slot in use",
    input: { action: "start", command: "pnpm dev", name: "dev" },
    service: {
      start: () =>
        Effect.fail(
          BackgroundTaskCapacityError.make({
            limit: 4,
            message: "Background task capacity reached (4).",
          }),
        ),
    },
  },
  {
    title: "logs with both a cursor and a line count",
    input: { action: "logs", id: "task-0000000003", afterCursor: 4, tailLines: 20 },
  },
  {
    title: "empty list",
    input: { action: "list", state: "active" },
    service: { list: () => Effect.succeed([]) },
  },
  {
    title: "clear",
    input: { action: "clear" },
    service: { clear: Effect.succeed(3) },
  },
];

const settle = (scenario: Scenario): Effect.Effect<GalleryScenario> => {
  const call = { title: scenario.title, args: scenario.input };
  if (scenario.phase) return Effect.succeed({ ...call, phase: scenario.phase });
  return executeBackgroundTaskCommand(scenario.input, "/project").pipe(
    provideTaskService(taskServiceDouble({ ...service, ...scenario.service })),
    Effect.match({
      onFailure: (error) => {
        const { text, details } = backgroundTaskFailure(error);
        return {
          ...call,
          isError: true,
          result: { content: [{ type: "text" as const, text }], details },
        };
      },
      onSuccess: (result) => ({
        ...call,
        result: {
          content: [{ type: "text" as const, text: result.text }],
          details: result.details,
        },
      }),
    }),
  );
};

interface RegisteredScenario {
  readonly title: string;
  readonly input: BackgroundTaskToolInput;
  readonly service: Partial<BackgroundTaskServiceContract>;
}

const registeredScenarios: ReadonlyArray<RegisteredScenario> = [
  {
    title: "started task whose structured result could not be built",
    input: { action: "start", command: "pnpm docs:dev", name: "docs" },
    service: {
      start: (request) =>
        started(
          "task-0000000013",
          48701,
        )(request).pipe(Effect.map((snapshot) => ({ ...snapshot, startedAt: -1 }))),
    },
  },
];

const settleRegistered = (scenario: RegisteredScenario): Effect.Effect<GalleryScenario> => {
  const tool = registeredTaskTool({ ...service, ...scenario.service });
  const ctx = extensionContextFixture({ cwd: "/project" });
  return Effect.promise(() =>
    tool.execute("gallery", scenario.input, undefined, undefined, ctx),
  ).pipe(
    Effect.map((result) => ({
      title: scenario.title,
      args: scenario.input,
      result,
      isError: result.isError === true,
    })),
  );
};

const notice = (
  title: string,
  taskStatusValue: BackgroundTaskStatus,
  lines: ReadonlyArray<Line>,
): GalleryMessageScenario => {
  const value = { ...taskStatusValue, startedAt: 1_000, endedAt: 94_000 };
  return {
    title,
    message: {
      role: "custom",
      timestamp: 0,
      display: true,
      ...taskNoticeMessage({
        task: value,
        recent: slice(value.id, value.state, lines, { from: 1 }),
        retained: true,
      }),
    },
  };
};

const noticeScenarios: ReadonlyArray<GalleryMessageScenario> = [
  notice("task exited", finished, [out("Found 0 errors in 212 files.")]),
  notice("task failed with a cause", failed, testLog),
  notice("task timed out", timedOut, [out("Applying migration 0042_add_sessions...")]),
  notice("task stopped by the user", stoppedServer, serverLog),
  notice("task killed without output", killed, []),
  // An unnamed task's heading is its whole command, so expansion doesn't repeat it.
  notice(
    "unnamed task with a long command",
    task({
      id: "task-0000000017",
      command: "pnpm vitest run --reporter=dot tests/task-service.test.ts tests/log-buffer.test.ts",
      state: "exited",
      endedAt: 42_001,
      exitCode: 0,
    }),
    [out("Test Files  2 passed (2)")],
  ),
  notice("unnamed task with a 449-character command", longUnnamed, [out("verified")]),
  notice("task in a folder under home", { ...finished, cwd: `${homedir()}/web` }, [
    out("Found 0 errors in 212 files."),
  ]),
  {
    title: "notice whose details could not be read",
    message: {
      role: "custom",
      timestamp: 0,
      customType: TASK_NOTICE_MESSAGE_TYPE,
      display: true,
      content: "Background task task-0000000099 exited with code 0 after 3s.",
      details: { task: { id: "task-0000000099" } },
    },
  },
];

/** Retained output events from display lines, one second apart. */
const logEvents = (lines: ReadonlyArray<Line>, at: number): BackgroundLogEvent[] =>
  Arr.map(lines, (line, index) => ({
    ...line,
    cursor: index + 1,
    timestamp: at + index * 1_000,
    bytes: line.text.length,
  }));

/** Live tasks as the shared Activity widget and view show them, beside a failed one. */
const activityLines = (): ReadonlyArray<string> => {
  const now = 120_000;
  const ticks = Arr.makeBy(18, (index) => out(`tick ${index + 1}`));
  const projection = {
    tasks: [
      {
        ...task({
          id: "task-0000000021",
          name: "ticker",
          state: "running",
          command: "for i in $(seq 1 90); do echo tick $i; sleep 1; done",
          startedAt: now - 18_000,
          logCursor: ticks.length,
        }),
        logs: logEvents(ticks, now - 18_000),
      },
      {
        ...task({
          id: "task-0000000022",
          name: "dev server",
          state: "running",
          command: "pnpm dev --port 4173",
          startedAt: now - 72_000,
          logCursor: 2,
        }),
        logs: logEvents(
          [out("  VITE v6.3.5  ready in 412 ms"), out("  ➜  Local:   http://localhost:4173/")],
          now - 70_000,
        ),
      },
      {
        ...task({
          id: "task-0000000023",
          name: "flaky build",
          command: "pnpm build",
          state: "failed",
          startedAt: now - 30_000,
          endedAt: now - 24_000,
          exitCode: 2,
          failureCause: "error: missing semicolon",
          logCursor: 2,
        }),
        logs: logEvents([out("compiling"), err("error: missing semicolon")], now - 25_000),
      },
    ],
  };
  const gallery = {
    title: "a ticker, a dev server, and a failed build",
    providerId: "pi-background-task",
    items: backgroundTaskActivityItems(projection),
    detail: (id: string) => backgroundTaskActivityDetail(projection, id),
    now,
  };
  return [
    ...activityGalleryFrames({ ...gallery, widths: [57, 180], maxRows: [8] }),
    ...activityGalleryFrames({ ...gallery, widths: [57], maxRows: [3], open: ["task-0000000023"] }),
    // Technical facts: a finished task's exit code, and a running one with no exit facts yet.
    ...activityGalleryFrames({
      ...gallery,
      title: `${gallery.title} · technical`,
      widths: [],
      managerWidths: [57, 180],
      open: ["task-0000000023", "task-0000000022"],
      technical: true,
    }),
  ];
};

type ScopeFiles = Parameters<typeof taskSettingsSubcommand>[0]["read"];

/**
 * `/tasks settings` through its subcommand, opened on `read`'s files. With `explore`, also the
 * Global group opened, one size's choice list, and the Project group.
 */
const settingsLines = (
  read: ScopeFiles,
  options: {
    readonly prefix?: string;
    readonly explore?: boolean;
    /** Saves Global's running limit as 16, then restores its inheritance, in one invocation. */
    readonly live?: boolean;
    /** Saves Global's running limit as 16, and the write lands while Project's choices are open. */
    readonly pending?: boolean;
  } = {},
): Effect.Effect<string[]> =>
  Effect.gen(function* () {
    setKeybindings(new TuiKeybindingsManager(TUI_KEYBINDINGS));
    const landed = deferredPromise();
    const command = taskSettingsSubcommand({
      config: () => ({ ...DEFAULT_BACKGROUND_TASK_CONFIG, logBufferBytesPerTask: 1024 ** 2 }),
      captureAuthority: () => () => true,
      read,
      write: () => (options.pending ? landed.promise : Promise.resolve()),
    });
    const surface = fakeCustomSurfaceHost();
    const ctx = extensionContextFixture({
      cwd: "/project",
      mode: "tui",
      hasUI: true,
      signal: new AbortController().signal,
      isProjectTrusted: () => true,
      ui: { custom: surface.ctx.ui.custom.bind(surface.ctx.ui), notify: () => undefined },
    });
    const opened = Promise.resolve(command.handler("", ctx));
    yield* macrotask;
    surface.mount();
    const frames = (title: string) =>
      Arr.flatMap([180, 57], (width) => [
        `── /tasks settings · ${options.prefix ?? ""}${title} · ${width} cols`,
        ...Arr.map(surface.editor?.render(width) ?? [], (line) => Str.trimEnd(line)),
        "",
      ]);
    const lines = [...frames("scope groups")];
    const press = (...keys: string[]) => {
      for (const key of keys) surface.editor?.handleInput?.(key);
    };
    if (options.pending) {
      press("\r", "j", "\r", "j", "j", "j", "\r");
      yield* macrotask;
      press("\u001b", "j", "\r", "j", "\r");
      lines.push(...frames("Project's running choices while Global's save is in flight"));
      landed.resolve();
      yield* macrotask;
      lines.push(...frames("Project's running choices once Global's save lands"));
      press("\u001b");
      lines.push(...frames("the Project group once Global's save lands"));
      press("\u001b", "\u001b");
      yield* Effect.promise(() => opened);
      return lines;
    }
    if (options.live) {
      // Global, its running limit, then 16: the list leads with `inherit (8)`, then 4, 8, 16.
      press("\r", "j", "\r", "j", "j", "j", "\r");
      yield* macrotask;
      press("\u001b");
      lines.push(...frames("after saving Global's limit as 16"));
      press("j", "\r");
      lines.push(...frames("the Project group after Global's save"));
      press("j", "\r");
      lines.push(...frames("Project's running choices after Global's save"));
      press("\u001b", "\u001b", "k", "\r", "j", "\r", "k", "k", "k", "\r");
      yield* macrotask;
      press("\u001b");
      lines.push(...frames("after restoring Global's inheritance"));
      press("j", "\r");
      lines.push(...frames("the Project group after restoring Global"));
      press("\u001b", "\u001b");
      yield* Effect.promise(() => opened);
      return lines;
    }
    if (!options.explore) {
      surface.editor?.handleInput?.("\u001b");
      yield* Effect.promise(() => opened);
      return lines;
    }
    surface.editor?.handleInput?.("\r");
    lines.push(...frames("the Global group opened"));
    for (const key of ["j", "j", "j"]) surface.editor?.handleInput?.(key);
    lines.push(...frames("the Global group on output per task"));
    for (const key of ["j", "j", "j", "j", "j"]) surface.editor?.handleInput?.(key);
    lines.push(...frames("the Global group on shell"));
    for (const key of ["k", "k", "k", "k", "k"]) surface.editor?.handleInput?.(key);
    surface.editor?.handleInput?.("\r");
    lines.push(...frames("output per task choices"));
    for (const key of ["\u001b", "\u001b", "j", "\r"]) surface.editor?.handleInput?.(key);
    lines.push(...frames("the Project group opened"));
    for (const key of ["\u001b", "\u001b"]) surface.editor?.handleInput?.(key);
    yield* Effect.promise(() => opened);
    return lines;
  });

/** `/tasks settings help` and `status` as Pi's notices show them, before any setting is saved. */
const settingsNoticeLines = (): Effect.Effect<string[]> =>
  Effect.gen(function* () {
    const notices: string[] = [];
    const command = taskSettingsSubcommand({
      config: () => DEFAULT_BACKGROUND_TASK_CONFIG,
      captureAuthority: () => () => true,
      read: () => Promise.resolve({}),
      write: () => Promise.resolve(),
    });
    const ctx = extensionContextFixture({
      cwd: "/project",
      mode: "tui",
      hasUI: true,
      isProjectTrusted: () => true,
      ui: { notify: (message: string) => void notices.push(message) },
    });
    const lines: string[] = [];
    for (const args of ["help", "status"]) {
      notices.length = 0;
      yield* Effect.promise(() => Promise.resolve(command.handler(args, ctx)));
      lines.push(`── /tasks settings ${args} · notice`, ...notices, "");
    }
    return lines;
  });

// Pi leads a warning or error notice with its level, one column in, and wraps at the terminal edge.
const noticeFrame = (level: "Warning" | "Error", message: string, width: number): string[] =>
  Arr.flatMap(Str.split(` ${level}: ${message}`, "\n"), (line, index) => {
    const indented = index === 0 ? line : ` ${line}`;
    const rows: string[] = [];
    for (let rest = indented; ; rest = Fn.pipe(rest, Str.slice(width))) {
      rows.push(Fn.pipe(rest, Str.slice(0, width)));
      if (rest.length <= width) return rows;
    }
  });

/** A command-line change whose save failed, as each common cause reads in Pi's error notice. */
const settingsSaveFailureLines = (): Effect.Effect<string[]> =>
  Effect.gen(function* () {
    const globalFile = `${homedir()}/.pi/agent/extensions/pi-background-task.json`;
    const nodeError = (code: string, text: string) =>
      Object.assign(new Error(`${code}: ${text}, open '${globalFile}'`), {
        code,
        path: globalFile,
      });
    const failures: ReadonlyArray<readonly [string, Error]> = [
      [
        "file can't be written",
        BackgroundTaskConfigError.make({
          operation: "write",
          path: globalFile,
          message: "Unable to write background tasks configuration.",
        }),
      ],
      ["permission denied", nodeError("EACCES", "permission denied")],
      ["read-only file system", nodeError("EROFS", "read-only file system")],
      ["disk full", nodeError("ENOSPC", "no space left on device")],
      ["folder missing", nodeError("ENOENT", "no such file or directory")],
    ];
    const lines: string[] = [];
    for (const [title, failure] of failures) {
      const notices: string[] = [];
      const command = taskSettingsSubcommand({
        config: () => DEFAULT_BACKGROUND_TASK_CONFIG,
        captureAuthority: () => () => true,
        read: () => Promise.resolve({}),
        write: () => Promise.reject(failure),
      });
      const ctx = extensionContextFixture({
        cwd: "/project",
        mode: "rpc",
        hasUI: true,
        isProjectTrusted: () => true,
        ui: { notify: (message: string) => void notices.push(message) },
      });
      yield* Effect.promise(() => Promise.resolve(command.handler("maxRunning 16", ctx)));
      for (const width of [57, 100])
        lines.push(
          `── /tasks settings maxRunning 16 · save failed, ${title} · ${width} cols`,
          ...Arr.flatMap(notices, (posted) => noticeFrame("Error", posted, width)),
          "",
        );
    }
    return lines;
  });

/** A path setting named without a value: the hint's placeholder matches the row's `<path>`. */
const settingsMissingPathLines = (): Effect.Effect<string[]> =>
  Effect.gen(function* () {
    const notices: string[] = [];
    const command = taskSettingsSubcommand({
      config: () => DEFAULT_BACKGROUND_TASK_CONFIG,
      captureAuthority: () => () => true,
      read: () => Promise.resolve({}),
      write: () => Promise.resolve(),
    });
    const ctx = extensionContextFixture({
      cwd: "/project",
      mode: "rpc",
      hasUI: true,
      isProjectTrusted: () => true,
      ui: { notify: (message: string) => void notices.push(message) },
    });
    const lines: string[] = [];
    for (const args of ["shellPath", "project shellPath"]) {
      notices.length = 0;
      yield* Effect.promise(() => Promise.resolve(command.handler(args, ctx)));
      for (const width of [57, 100])
        lines.push(
          `── /tasks settings ${args} · missing value · ${width} cols`,
          ...Arr.flatMap(notices, (posted) => noticeFrame("Warning", posted, width)),
          "",
        );
    }
    return lines;
  });

/** The Longest wait setting at zero and a rejected wait, both read in whole seconds. */
const settingsZeroWaitLines = (): Effect.Effect<string[]> =>
  Effect.gen(function* () {
    const notices: string[] = [];
    const command = taskSettingsSubcommand({
      config: () => ({ ...DEFAULT_BACKGROUND_TASK_CONFIG, maxWaitSeconds: 0 }),
      captureAuthority: () => () => true,
      read: () => Promise.resolve({}),
      write: () => Promise.resolve(),
    });
    const ctx = extensionContextFixture({
      cwd: "/project",
      mode: "rpc",
      hasUI: true,
      isProjectTrusted: () => true,
      ui: { notify: (message: string) => void notices.push(message) },
    });
    yield* Effect.promise(() => Promise.resolve(command.handler("status", ctx)));
    const lines = ["── /tasks settings status · a zero longest wait · notice", ...notices, ""];
    notices.length = 0;
    yield* Effect.promise(() => Promise.resolve(command.handler("maxWaitSeconds 500ms", ctx)));
    for (const width of [57, 100])
      lines.push(
        `── /tasks settings maxWaitSeconds 500ms · rejected · ${width} cols`,
        ...Arr.flatMap(notices, (posted) => noticeFrame("Warning", posted, width)),
        "",
      );
    return lines;
  });

const directory = galleryDirectory(process.env) ?? "";

const titled = <A extends { readonly title: string }>(entries: ReadonlyArray<A>, title: string) =>
  Option.getOrThrow(Arr.findFirst(entries, (entry) => entry.title === title));

describe.skipIf(!directory)("presentation gallery", () => {
  beforeAll(() => initTheme("dark", false));

  it.effect("renders background task outcomes in both collapsed styles", () =>
    Effect.gen(function* () {
      const results = [
        ...(yield* Effect.forEach(scenarios, settle)),
        ...(yield* Effect.forEach(registeredScenarios, settleRegistered)),
      ];
      const lines: string[] = [];
      for (const style of ["compact", "preview"] as const) {
        const restore = applyPresentationSettings({
          toolCallCollapsedStyle: style,
          toolCallTiming: false,
        });
        try {
          const tool = captureRegistrations((pi) =>
            registerBackgroundTaskTool(pi, {
              run: () => Promise.reject(new Error("not executed")),
            }),
          ).tools[0]!;
          for (const scenario of results)
            lines.push(
              ...galleryFrames(tool, { ...scenario, title: `${style} · ${scenario.title}` }),
            );
          for (const scenario of noticeScenarios)
            lines.push(
              ...galleryMessageFrames(renderTaskNotice, {
                ...scenario,
                title: `${style} · notice · ${scenario.title}`,
              }),
            );
          const startedTask = titled(results, "started a task that reports when it finishes");
          for (const background of ["border", "on", "off"] as const)
            withPresentationSettings({ toolCallBackground: background }, () => {
              const framed = captureRegistrations((pi) =>
                registerBackgroundTaskTool(pi, {
                  run: () => Promise.reject(new Error("not executed")),
                }),
              ).tools[0]!;
              lines.push(
                ...galleryTranscriptFrames(
                  `${style} · ${background} · transcript: a task start beside its exit notices`,
                  [
                    {
                      name: framed.name,
                      tool: framed,
                      args: startedTask.args,
                      result: { ...startedTask.result!, isError: startedTask.isError ?? false },
                    },
                    {
                      render: renderTaskNotice,
                      message: titled(noticeScenarios, "task exited").message,
                    },
                    {
                      render: renderTaskNotice,
                      message: titled(noticeScenarios, "task failed with a cause").message,
                    },
                  ],
                ),
              );
            });
        } finally {
          restore();
        }
      }
      lines.push(...activityLines());
      // The global file sets a per-task size the project row inherits, and the project sets its
      // own running limit.
      lines.push(
        ...(yield* settingsLines(
          (location) =>
            Promise.resolve(
              location.scope === "global"
                ? { logBufferBytesPerTask: 1024 ** 2, stopGraceMs: 5_000 }
                : { maxRunning: 16 },
            ),
          { explore: true },
        )),
        ...(yield* settingsLines(() => Promise.resolve({}), { prefix: "default files · " })),
        ...(yield* settingsLines(() => Promise.resolve({}), {
          prefix: "one invocation · ",
          live: true,
        })),
        ...(yield* settingsLines(() => Promise.resolve({}), {
          prefix: "save in flight · ",
          pending: true,
        })),
        ...(yield* settingsNoticeLines()),
        ...(yield* settingsSaveFailureLines()),
        ...(yield* settingsMissingPathLines()),
        ...(yield* settingsZeroWaitLines()),
        ...(yield* settingsLines(
          (location) => Promise.resolve(location.scope === "global" ? { enabled: false } : {}),
          { prefix: "tasks off globally · " },
        )),
      );
      yield* writeGallerySection(directory, "pi-background-task", lines);
    }),
  );
});
