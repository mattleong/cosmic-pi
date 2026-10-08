import * as Effect from "effect/Effect";
import {
  applyPresentationSettings,
  captureRegistrations,
  galleryDirectory,
  galleryFrames,
  writeGallerySection,
  type GalleryScenario,
} from "pi-code-previews/testing";
import { extensionContextFixture } from "pi-cosmic-core/testing";
import { describe, it } from "@effect/vitest";
import { backgroundTaskNotFound, InvalidBackgroundCwdError } from "../src/task/errors.ts";
import type { BackgroundLogEvent, BackgroundTaskStatus } from "../src/task/model.ts";
import type { BackgroundTaskServiceContract } from "../src/task/service.ts";
import { registerBackgroundTaskTool } from "../src/tools/background-task.ts";
import { executeBackgroundTaskCommand } from "../src/tools/command.ts";
import type { BackgroundTaskToolInput } from "../src/tools/schema.ts";
import {
  provideTaskService,
  taskLogSlice as slice,
  taskServiceDouble,
  taskServiceRunner,
  taskStatus,
  taskWait,
} from "./support/task-service-double.ts";

/** A gallery task: the neutral fixture defaults, with output through cursor 12. */
const task = (fields: Parameters<typeof taskStatus>[0]) => taskStatus({ logCursor: 12, ...fields });
const failed = task({
  id: "task-1",
  name: "tests",
  state: "failed",
  endedAt: 2,
  exitCode: 1,
  failureCause: "FAIL tests/auth.test.ts > rejects expired tokens",
});
const killed = task({
  id: "task-2",
  name: "build",
  command: "pnpm build",
  state: "failed",
  endedAt: 2,
  exitCode: 137,
});
const running = task({
  id: "task-3",
  name: "server",
  command: "pnpm dev",
  state: "running",
  pid: 48213,
});
const stopping = task({
  id: "task-4",
  name: "e2e",
  command: "pnpm test:e2e",
  state: "stopping",
  pid: 48377,
});
const timedOut = task({
  id: "task-5",
  name: "migrate",
  command: "pnpm db:migrate",
  state: "timed_out",
  startedAt: 1_000,
  endedAt: 301_400,
  exitCode: null,
  signal: "SIGTERM",
});
const exitUnknown = task({
  id: "task-6",
  name: "lint",
  command: "pnpm lint",
  state: "exited",
  endedAt: 2,
  exitCode: null,
});
const spawnFailed = task({
  id: "task-7",
  name: "deploy",
  command: "./scripts/deploy.sh",
  state: "failed",
  endedAt: 2,
  logCursor: 0,
  error: "Couldn't start the process",
});
const finished = task({
  id: "task-8",
  name: "typecheck",
  command: "pnpm typecheck",
  state: "exited",
  endedAt: 2,
  exitCode: 0,
});
const stoppedServer: BackgroundTaskStatus = {
  ...running,
  state: "stopped",
  endedAt: 2,
  exitCode: null,
  signal: "SIGTERM",
};
const noisy = task({
  id: "task-9",
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
  endedAt: 2,
  exitCode: null,
  signal: "SIGTERM",
};
const unnamed = task({
  id: "task-12",
  command: "node scripts/seed.js --fixtures=large",
  state: "failed",
  endedAt: 2,
  exitCode: 127,
});
const byId = new Map(
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
  ].map((task) => [task.id, task]),
);

type Line = Pick<BackgroundLogEvent, "stream" | "text">;
const out = (text: string): Line => ({ stream: "stdout", text: `${text}\n` });
const err = (text: string): Line => ({ stream: "stderr", text: `${text}\n` });

const service: Partial<BackgroundTaskServiceContract> = {
  list: () => Effect.succeed([running, failed, killed]),
  status: (id) => {
    const task = byId.get(id);
    return task ? Effect.succeed(task) : Effect.fail(backgroundTaskNotFound(id));
  },
};

/** The service's start: the requested task, now running. */
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
  /** The service calls this scenario reaches, over the shared stub. */
  readonly service?: Partial<BackgroundTaskServiceContract>;
  /** An unsettled call: nothing executes and no result has arrived. */
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
  out(`!function(){${"var a=1;".repeat(8_000)}}();`),
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
    service: { start: started("task-10", 48590) },
  },
  {
    title: "started an unnamed task in a subdirectory",
    input: {
      action: "start",
      command: "pnpm vitest --watch --reporter=dot tests/task-service.test.ts",
      cwd: "packages/pi-background-task",
    },
    service: { start: started("task-11", 48612) },
  },
  {
    title: "start in a missing directory",
    input: { action: "start", command: "pnpm dev", cwd: "apps/missing" },
    service: {
      start: (request) =>
        Effect.fail(
          new InvalidBackgroundCwdError({
            cwd: request.cwd,
            message: `Couldn't find the working directory ${request.cwd}`,
          }),
        ),
    },
  },
  { title: "finished task", input: { action: "status", id: "task-8" } },
  { title: "failed task with a cause", input: { action: "status", id: "task-1" } },
  { title: "task killed without output", input: { action: "status", id: "task-2" } },
  { title: "task still stopping", input: { action: "status", id: "task-4" } },
  { title: "task timed out", input: { action: "status", id: "task-5" } },
  { title: "task exited with an unknown code", input: { action: "status", id: "task-6" } },
  { title: "task that failed to spawn", input: { action: "status", id: "task-7" } },
  { title: "task that lost output", input: { action: "status", id: "task-9" } },
  { title: "unnamed task whose command was not found", input: { action: "status", id: "task-12" } },
  { title: "status of an unknown task", input: { action: "status", id: "task-42" } },
  {
    title: "short log slice",
    input: { action: "logs", id: "task-3", tailLines: 5 },
    service: { logs: () => Effect.succeed(slice("task-3", "running", serverLog, { from: 9 })) },
  },
  {
    title: "long log slice",
    input: { action: "logs", id: "task-3", tailLines: 30 },
    service: { logs: () => Effect.succeed(slice("task-3", "running", requestLog, { from: 40 })) },
  },
  {
    title: "logs after output was discarded",
    input: { action: "logs", id: "task-3", afterCursor: 4 },
    service: {
      logs: () =>
        Effect.succeed(
          slice("task-3", "running", requestLog.slice(0, 3), { from: 212, droppedBytes: 18_432 }),
        ),
    },
  },
  {
    title: "log slice cut to the output limit",
    input: { action: "logs", id: "task-9", tailLines: 3 },
    service: { logs: () => Effect.succeed(slice("task-9", "running", bundleLog, { from: 7 })) },
  },
  {
    title: "logs of a failed task",
    input: { action: "logs", id: "task-1", tailLines: 4 },
    service: { logs: () => Effect.succeed(slice("task-1", "failed", testLog, { from: 9 })) },
  },
  {
    title: "logs with no new output",
    input: { action: "logs", id: "task-3", afterCursor: 11, waitSeconds: 5 },
    service: { logs: () => Effect.succeed(slice("task-3", "running", [], { from: 12 })) },
  },
  {
    title: "wait in progress",
    input: { action: "wait", id: "task-3", until: "exit" },
    phase: "running",
  },
  {
    title: "wait matched output",
    input: { action: "wait", id: "task-3", until: "output", contains: "ready in" },
    service: { wait: () => Effect.succeed(taskWait(running, "matched", { matchCursor: 9 })) },
  },
  {
    title: "wait completed",
    input: { action: "wait", id: "task-8", until: "exit" },
    service: { wait: () => Effect.succeed(taskWait(finished, "completed")) },
  },
  {
    title: "wait completed with a failure",
    input: { action: "wait", id: "task-1", until: "exit" },
    service: { wait: () => Effect.succeed(taskWait(failed, "completed")) },
  },
  {
    title: "wait timed out",
    input: { action: "wait", id: "task-3", until: "exit", waitSeconds: 30 },
    service: { wait: () => Effect.succeed(taskWait(running, "timeout")) },
  },
  {
    title: "stop",
    input: { action: "stop", id: "task-3" },
    service: { stop: () => Effect.succeed(stoppedServer) },
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
    input: { action: "stop", id: "task-4", force: true },
    service: { stop: () => Effect.succeed(stopping) },
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

/** A scenario as the tool call shows it: settled through the shared executor, or still open. */
const settle = (scenario: Scenario): Effect.Effect<GalleryScenario> => {
  const call = { title: scenario.title, args: scenario.input };
  if (scenario.phase) return Effect.succeed({ ...call, phase: scenario.phase });
  return executeBackgroundTaskCommand(scenario.input, "/project").pipe(
    provideTaskService(taskServiceDouble({ ...service, ...scenario.service })),
    Effect.match({
      // Pi turns a rejected execution into an error result carrying only the message.
      onFailure: (error) => ({
        ...call,
        isError: true,
        result: { content: [{ type: "text" as const, text: error.message }], details: {} },
      }),
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

/** A scenario that needs what the registered definition adds beyond the shared executor. */
interface RegisteredScenario {
  readonly title: string;
  readonly input: BackgroundTaskToolInput;
  readonly service: Partial<BackgroundTaskServiceContract>;
}

const registeredScenarios: ReadonlyArray<RegisteredScenario> = [
  {
    // A fact outside the script contract's bounds: the task started, so the model keeps its
    // receipt, marked as an error, and scripts receive no structured result.
    title: "started task whose structured result could not be built",
    input: { action: "start", command: "pnpm docs:dev", name: "docs" },
    service: {
      start: (request) =>
        started("task-13", 48701)(request).pipe(Effect.map((task) => ({ ...task, startedAt: -1 }))),
    },
  },
];

/** Settles a scenario through the registered definition's own execute, over its service. */
const settleRegistered = (scenario: RegisteredScenario): Effect.Effect<GalleryScenario> => {
  const tool = captureRegistrations((pi) =>
    registerBackgroundTaskTool(pi, {
      run: taskServiceRunner(taskServiceDouble({ ...service, ...scenario.service })),
    }),
  ).tools[0]!;
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

const directory = galleryDirectory(process.env) ?? "";

describe.skipIf(!directory)("presentation gallery", () => {
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
        } finally {
          restore();
        }
      }
      yield* writeGallerySection(directory, "pi-background-task", lines);
    }),
  );
});
