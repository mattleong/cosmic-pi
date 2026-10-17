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
import { BackgroundTaskService } from "../src/task/service.ts";
import { nativeCodemodeSession } from "./support/native-codemode-session.ts";
import { taskServiceDouble, taskStatus, taskWait } from "./support/task-service-double.ts";

const decodeOutput = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const literal = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const output = (text: string) => {
  const line = text.split("\n").find((candidate) => candidate.startsWith("WORKFLOW_RESULT "));
  expect(line, text).toBeDefined();
  return decodeOutput(line!.slice("WORKFLOW_RESULT ".length));
};
const print = (expression: string) => `text('WORKFLOW_RESULT ' + JSON.stringify(${expression}));`;
const envelope = { contract: "pi-background-task/task", version: 1, tool: "background_task" };

describe("native scripted background task workflows", () => {
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
