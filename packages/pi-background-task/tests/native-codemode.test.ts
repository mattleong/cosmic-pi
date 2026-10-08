// Actual Pi agent loop and native QuickJS, with owned task-service and Path boundaries only.
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { LocalProcess } from "../src/boundary/local-process.ts";
import { normalizeConfig } from "../src/config/options.ts";
import { BackgroundTaskConfigStore } from "../src/config/store.ts";
import { backgroundTaskNotFound } from "../src/task/errors.ts";
import type { ReadBackgroundLogs } from "../src/task/model.ts";
import { BackgroundTaskService } from "../src/task/service.ts";
import { nativeCodemodeSession } from "./support/native-codemode-session.ts";
import {
  taskLogSlice,
  taskServiceDouble,
  taskStatus,
  taskWait,
} from "./support/task-service-double.ts";

const decodeOutput = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
/** A JavaScript string literal for embedding test data in a script. */
const literal = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const output = (text: string) => {
  const line = text.split("\n").find((line) => line.startsWith("WORKFLOW_RESULT "));
  expect(line, text).toBeDefined();
  return decodeOutput(line!.slice("WORKFLOW_RESULT ".length));
};
const print = (expression: string) => `text('WORKFLOW_RESULT ' + JSON.stringify(${expression}));`;
const envelope = { contract: "pi-background-task/task", version: 1, tool: "background_task" };

// Live time is intentional: each test drives the actual native QuickJS worker, not an LLM.
describe("native scripted background task workflows", () => {
  it.live(
    "carries start, output wait, cursor logs, and stop as structured task objects",
    () =>
      Effect.gen(function* () {
        const logRequests: ReadBackgroundLogs[] = [];
        const running = taskStatus({ id: "task-1", name: "dev", state: "running", pid: 4242 });
        const service = taskServiceDouble({
          start: (request) =>
            Effect.succeed({ ...running, command: request.command, cwd: request.cwd }),
          wait: () =>
            Effect.succeed(taskWait({ ...running, logCursor: 2 }, "matched", { matchCursor: 2 })),
          logs: (request) =>
            Effect.sync(() => {
              logRequests.push(request);
              // One new line after the match, then nothing past it.
              return request.afterCursor === 2
                ? taskLogSlice("task-1", "running", [{ stream: "stdout", text: "GET / 200\n" }], {
                    from: 3,
                  })
                : taskLogSlice("task-1", "running", [], { from: 4 });
            }),
          stop: (id) =>
            Effect.succeed(
              taskStatus({
                id,
                name: "dev",
                state: "stopped",
                endedAt: 5,
                exitCode: null,
                signal: "SIGTERM",
                logCursor: 3,
              }),
            ),
        });
        const h = yield* nativeCodemodeSession(service);
        const result = yield* h.run(`
          const started = await tools.background_task({action:'start',command:'pnpm dev',name:'dev'});
          text('TASK ' + started.task.id);
          const id = started.task.id;
          const ready = await tools.background_task({action:'wait',id,until:'output',contains:'ready',waitSeconds:10});
          const recent = await tools.background_task({action:'logs',id,afterCursor:ready.matchCursor});
          const idle = await tools.background_task({action:'logs',id,afterCursor:recent.nextCursor});
          const stopped = await tools.background_task({action:'stop',id});
          ${print("{started,ready,recent,idle,stopped}")}
        `);
        expect(result.isError, result.text).toBe(false);
        const value = output(result.text);
        expect(value).toMatchObject({
          started: {
            ...envelope,
            action: "start",
            task: { id: "task-1", name: "dev", state: "running", finished: false },
          },
          ready: {
            ...envelope,
            action: "wait",
            outcome: "matched",
            matchCursor: 2,
            task: { id: "task-1", state: "running", finished: false },
          },
          recent: {
            ...envelope,
            action: "logs",
            id: "task-1",
            state: "running",
            finished: false,
            output: "GET / 200\n",
            truncated: false,
            nextCursor: 3,
          },
          idle: { action: "logs", output: "", nextCursor: 3 },
          stopped: {
            ...envelope,
            action: "stop",
            task: { id: "task-1", state: "stopped", finished: true, exitCode: null },
          },
        });
        // Scripts receive task metadata only: never the command, cwd, or process ID.
        for (const field of ["command", "cwd", "pid"])
          expect(value).not.toHaveProperty(["started", "task", field]);
        expect(logRequests.map((request) => request.afterCursor)).toEqual([2, 3]);
      }).pipe(Effect.provide(nodeFilePlatformLayer)),
    15_000,
  );

  it.live(
    "resolves a failed task exit as a successful operation with its evidence",
    () =>
      Effect.gen(function* () {
        const failed = taskStatus({
          id: "task-2",
          name: "tests",
          state: "failed",
          endedAt: 9,
          exitCode: 1,
          failureCause: "FAIL tests/auth.test.ts > rejects expired tokens",
          logCursor: 7,
        });
        const spawnFailed = taskStatus({
          id: "task-3",
          name: "deploy",
          state: "failed",
          endedAt: 2,
          error: "Couldn't start the process",
        });
        const service = taskServiceDouble({
          wait: () => Effect.succeed(taskWait(failed, "completed")),
          status: (id) =>
            id === spawnFailed.id
              ? Effect.succeed(spawnFailed)
              : Effect.fail(backgroundTaskNotFound(id)),
        });
        const h = yield* nativeCodemodeSession(service);
        const result = yield* h.run(`
          const exited = await tools.background_task({action:'wait',id:'task-2',until:'exit',waitSeconds:5});
          const spawn = await tools.background_task({action:'status',id:'task-3'});
          ${print("{exited,spawn}")}
        `);
        expect(result.isError, result.text).toBe(false);
        const value = output(result.text);
        expect(value).toMatchObject({
          exited: {
            ...envelope,
            action: "wait",
            outcome: "completed",
            task: {
              id: "task-2",
              state: "failed",
              finished: true,
              exitCode: 1,
              cause: "FAIL tests/auth.test.ts > rejects expired tokens",
            },
          },
          spawn: {
            ...envelope,
            action: "status",
            task: {
              id: "task-3",
              state: "failed",
              finished: true,
              error: "Couldn't start the process",
            },
          },
        });
        expect(value).not.toHaveProperty(["spawn", "task", "exitCode"]);
      }).pipe(Effect.provide(nodeFilePlatformLayer)),
    15_000,
  );

  it.live(
    "rejects unknown tasks, missing IDs, and invalid waits without structured data",
    () =>
      Effect.gen(function* () {
        const service = taskServiceDouble({
          status: (id) => Effect.fail(backgroundTaskNotFound(id)),
        });
        const h = yield* nativeCodemodeSession(service);
        const result = yield* h.run(`
          const outcomes = [];
          for (const args of [
            {action:'status',id:'task-404'},
            {action:'stop'},
            {action:'wait',id:'task-1'},
          ]) {
            try { outcomes.push({action:args.action,value:await tools.background_task(args)}); }
            catch { outcomes.push({action:args.action,rejected:true}); }
          }
          ${print("outcomes")}
        `);
        expect(output(result.text)).toEqual([
          { action: "status", rejected: true },
          { action: "stop", rejected: true },
          { action: "wait", rejected: true },
        ]);
      }).pipe(Effect.provide(nodeFilePlatformLayer)),
    15_000,
  );

  it.live(
    "rejects an unencodable result in scripts while keeping the original receipt",
    () =>
      Effect.gen(function* () {
        // A fact outside the contract bounds: the start happened, so its receipt must survive.
        const service = taskServiceDouble({
          start: () =>
            Effect.succeed(taskStatus({ id: "task-7", state: "running", startedAt: -1 })),
        });
        const h = yield* nativeCodemodeSession(service);
        const result = yield* h.run(`
          let rejected = false;
          try { await tools.background_task({action:'start',command:'pnpm dev'}); }
          catch (error) { rejected = true; text(String(error && error.message)); }
          ${print("{rejected}")}
        `);
        expect(output(result.text)).toEqual({ rejected: true });
        expect(result.text).toContain("task-7");
        const direct = yield* h.call("background_task", { action: "start", command: "pnpm dev" });
        expect(direct.isError).toBe(true);
        expect(direct.text).toContain("task-7");
        expect(direct.message.details).toMatchObject({
          action: "start",
          snapshot: { id: "task-7", state: "running" },
        });
      }).pipe(Effect.provide(nodeFilePlatformLayer)),
    15_000,
  );

  it.live(
    "aborting a scripted wait releases only that wait and a later wait succeeds",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const released = yield* Deferred.make<void>();
        const running = taskStatus({ id: "task-6", name: "server", state: "running", pid: 4747 });
        let block = true;
        const service = taskServiceDouble({
          wait: () =>
            block
              ? Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() => Deferred.succeed(released, undefined)),
                )
              : Effect.succeed(taskWait(running, "matched", { matchCursor: 1 })),
        });
        const h = yield* nativeCodemodeSession(service);
        const script = yield* h
          .run("await tools.background_task({action:'wait',id:'task-6',until:'exit'});")
          .pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* Effect.promise(() => h.session.abort());
        yield* Fiber.join(script);
        yield* Deferred.await(released);
        block = false;
        const later = yield* h.run(`
          const r = await tools.background_task({action:'wait',id:'task-6',until:'output',contains:'ready'});
          ${print("{outcome:r.outcome,state:r.task.state}")}
        `);
        expect(output(later.text)).toEqual({ outcome: "matched", state: "running" });
      }).pipe(Effect.provide(nodeFilePlatformLayer)),
    15_000,
  );
});

// One offline smoke over the real service and a live scoped process; nothing reaches a model.
const realServiceLayer = BackgroundTaskService.layer().pipe(
  Layer.provide(
    Layer.mergeAll(
      LocalProcess.layer,
      Layer.succeed(BackgroundTaskConfigStore, normalizeConfig()),
      Path.layer,
    ),
  ),
);

describe("native scripted background task smoke", () => {
  it.live(
    "runs a real short command through start, exit wait, and logs",
    () =>
      Effect.gen(function* () {
        const h = yield* nativeCodemodeSession(yield* BackgroundTaskService);
        const command = `node -e "process.stdout.write('workflow-smoke')"`;
        const result = yield* h.run(`
          const started = await tools.background_task({action:'start',command:${literal(command)},name:'smoke'});
          text('TASK ' + started.task.id);
          const exited = await tools.background_task({action:'wait',id:started.task.id,until:'exit',waitSeconds:20});
          const logs = await tools.background_task({action:'logs',id:started.task.id});
          ${print("{started,exited,logs}")}
        `);
        expect(result.isError, result.text).toBe(false);
        expect(output(result.text)).toMatchObject({
          started: { ...envelope, action: "start", task: { name: "smoke" } },
          exited: {
            ...envelope,
            action: "wait",
            outcome: "completed",
            task: { name: "smoke", state: "exited", finished: true, exitCode: 0 },
          },
          logs: {
            ...envelope,
            action: "logs",
            state: "exited",
            finished: true,
            output: "workflow-smoke",
            truncated: false,
            droppedBytes: 0,
          },
        });
      }).pipe(Effect.provide(Layer.merge(realServiceLayer, nodeFilePlatformLayer))),
    30_000,
  );
});
