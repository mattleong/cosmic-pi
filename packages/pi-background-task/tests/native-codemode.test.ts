import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Fn from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
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
  const line = Option.getOrUndefined(
    Arr.findFirst(Str.split(text, "\n"), (candidate) =>
      Fn.pipe(candidate, Str.startsWith("WORKFLOW_RESULT ")),
    ),
  );
  expect(line, text).toBeDefined();
  return decodeOutput(Fn.pipe(line!, Str.slice("WORKFLOW_RESULT ".length)));
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

  it.live(
    "rejects a field the action does not use instead of widening the action",
    () =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const service = taskServiceDouble({
          stopAll: () =>
            Effect.sync(() => {
              calls.push("stopAll");
              return [];
            }),
          clear: Effect.sync(() => {
            calls.push("clear");
            return 0;
          }),
        });
        const h = yield* nativeCodemodeSession(service);
        const result = yield* h.run(`
          const outcomes = [];
          for (const args of [{action:'stop_all',id:'task-1'},{action:'clear',id:'task-1'}]) {
            try { await tools.background_task(args); outcomes.push('accepted'); }
            catch (error) { outcomes.push(String(error?.message ?? error)); }
          }
          ${print("outcomes")}
        `);
        expect(calls).toEqual([]);
        const outcomes = output(result.text);
        expect(Arr.isArray(outcomes) ? outcomes.length : 0).toBe(2);
        for (const outcome of Arr.isArray(outcomes) ? outcomes : [])
          expect(outcome).toMatch(/does not accept id/u);
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

  it.live(
    "accepts waitSeconds and tailLines above their caps and applies the caps",
    () =>
      Effect.gen(function* () {
        const h = yield* nativeCodemodeSession(yield* BackgroundTaskService);
        const command = `node -e "for (let i = 1; i <= 2500; i++) console.log(i)"`;
        const result = yield* h.run(`
          const started = await tools.background_task({action:'start',command:${literal(command)}});
          const exited = await tools.background_task({action:'wait',id:started.task.id,until:'exit',waitSeconds:300});
          const logs = await tools.background_task({action:'logs',id:started.task.id,tailLines:5000});
          ${print("{exited,lines:logs.output.split('\\n').filter(Boolean),truncated:logs.truncated}")}
        `);
        expect(result.isError, result.text).toBe(false);
        const { exited, lines, truncated } = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            exited: Schema.Struct({ outcome: Schema.String, appliedWaitSeconds: Schema.Finite }),
            lines: Schema.Array(Schema.String),
            truncated: Schema.Boolean,
          }),
        )(output(result.text));
        expect(exited).toEqual({ outcome: "completed", appliedWaitSeconds: 30 });
        expect(lines).toHaveLength(2_000);
        expect(lines.at(0)).toBe("501");
        expect(lines.at(-1)).toBe("2500");
        expect(truncated).toBe(true);
      }).pipe(Effect.provide(Layer.merge(realServiceLayer, nodeFilePlatformLayer))),
    30_000,
  );
});
