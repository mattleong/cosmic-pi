import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { makeCodeModeToolExecute } from "../../src/tools/execution.ts";
import { evaluationError } from "../../eval/errors.ts";
import {
  fixtureDefinitions,
  fixturePath,
  FixtureBoundaryError,
  freshDispatchMetrics,
} from "../../eval/fixture-tools.ts";
import {
  closeSessionEffect,
  materialize,
  promptWithDeadline,
  unchanged,
} from "../../eval/host-session.ts";
import { tasks } from "../../eval/tasks.ts";
import { codeModeStateFixture, extensionContextFixture } from "../support/host.ts";

describe("read-only evaluation fixtures", () => {
  it.live(
    "allows fixture reads and blocks parent, absolute, symlink, and shell escapes in both routes",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "code-mode-eval-test-" }),
        );
        const root = yield* fs.makeTempDirectoryScoped({ directory: parent, prefix: "fixture-" });
        yield* fs.writeFileString(path.join(root, "input.txt"), "fixture\n");
        yield* fs.writeFileString(path.join(parent, "outside.txt"), "outside\n");
        yield* fs.symlink(path.join(parent, "outside.txt"), path.join(root, "escape.txt"));
        expect(yield* Effect.tryPromise(() => fixturePath(root, "input.txt"))).toBe(
          path.join(root, "input.txt"),
        );
        for (const input of ["../outside.txt", path.join(parent, "outside.txt"), "escape.txt"]) {
          yield* Effect.tryPromise(() =>
            expect(fixturePath(root, input)).rejects.toBeInstanceOf(FixtureBoundaryError),
          );
        }
        const ctx = extensionContextFixture({ cwd: root });
        yield* fs.writeFileString(path.join(root, "large.txt"), "data\n".repeat(2500));
        for (const nested of [false, true]) {
          const metrics = freshDispatchMetrics();
          const tools = fixtureDefinitions(root, metrics, nested);
          const result = yield* Effect.tryPromise(() =>
            tools.read.execute("read", { path: "input.txt" }, undefined, undefined, ctx),
          );
          expect(
            result.content.some((block) => block.type === "text" && block.text.includes("fixture")),
          ).toBe(true);
          yield* Effect.tryPromise(() =>
            expect(
              tools.bash.execute("shell", { command: "true" }, undefined, undefined, ctx),
            ).rejects.toBeInstanceOf(FixtureBoundaryError),
          );
          yield* Effect.tryPromise(() =>
            expect(
              tools.write.execute(
                "write",
                { path: "input.txt", content: "changed" },
                undefined,
                undefined,
                ctx,
              ),
            ).rejects.toBeInstanceOf(FixtureBoundaryError),
          );
          expect(metrics.boundaryViolations).toBe(2);
          expect(metrics.nestedSucceeded).toBe(nested ? 1 : 0);
          expect(metrics.nestedCalls).toBe(nested ? 3 : 0);
          expect(metrics.nestedErrors).toBe(nested ? 2 : 0);
          expect(metrics.nestedOutputBytes).toBe(nested ? Buffer.byteLength("fixture\n") : 0);
          // Pi strips @ before resolving a path. The guard must forward its canonical
          // absolute path, so this spelling cannot list the host root after validation.
          const listed = yield* Effect.tryPromise(() =>
            tools.ls.execute("normalized", { path: "@/.." }, undefined, undefined, ctx),
          );
          const text = listed.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n");
          expect(text).toContain("input.txt");
          expect(text).not.toContain("outside.txt");
          yield* Effect.tryPromise(() =>
            tools.read.execute("large", { path: "large.txt" }, undefined, undefined, ctx),
          );
          expect(metrics.nativeTruncations).toBe(1);
          yield* Effect.tryPromise(() =>
            expect(
              tools.read.execute(
                "cancelled",
                { path: "input.txt" },
                AbortSignal.abort(),
                undefined,
                ctx,
              ),
            ).rejects.toBeDefined(),
          );
          expect(metrics.nestedErrors).toBe(nested ? 3 : 0);
        }
        const metrics = freshDispatchMetrics();
        const run = Effect.runPromiseWith(yield* Effect.context());
        const execute = makeCodeModeToolExecute({
          isCurrent: () => true,
          getState: () => codeModeStateFixture(),
          runInSession: (effect, signal) => run(effect, { signal }),
          definitions: fixtureDefinitions(root, metrics, true),
          events: createEventBus(),
          sessionId: "eval-test",
        });
        const result = yield* Effect.tryPromise(() =>
          execute(
            "interpreter",
            { code: "return await tools.pi.ls({path: '@/..'});" },
            undefined,
            undefined,
            ctx,
          ),
        );
        const text = result.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n");
        expect(text).toContain("input.txt");
        expect(text).not.toContain("outside.txt");
        expect(metrics.nestedSucceeded).toBe(1);
      }).pipe(Effect.provide(nodeFilePlatformLayer)),
  );

  it.live("independently detects mutations and validates the generated log oracle", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "code-mode-eval-test-" }),
      );
      const task = tasks.find((item) => item.id === "H4")!;
      yield* Effect.tryPromise(() => materialize(root, task));
      expect(yield* Effect.tryPromise(() => unchanged(root, task))).toBe(true);
      // Independent integer arithmetic checks the frozen oracle, not the agent's computation.
      const byService = { api: { errors: 0, maxLatency: 0 }, worker: { errors: 0, maxLatency: 0 } };
      for (let id = 0; id < 2000; id += 17) {
        const bucket = id % 3 === 0 ? byService.api : byService.worker;
        bucket.errors++;
        bucket.maxLatency = Math.max(bucket.maxLatency, (id % 97) + 1);
      }
      expect(byService).toEqual(task.expected);
      yield* fs.writeFileString(path.join(root, "extra.txt"), "extra");
      expect(yield* Effect.tryPromise(() => unchanged(root, task))).toBe(false);
      yield* fs.remove(path.join(root, "extra.txt"));
      const original = Object.keys(task.files)[0]!;
      yield* fs.remove(path.join(root, original));
      expect(yield* Effect.tryPromise(() => unchanged(root, task))).toBe(false);
      yield* fs.symlink(path.join(root, "missing.txt"), path.join(root, original));
      expect(yield* Effect.tryPromise(() => unchanged(root, task))).toBe(false);
    }).pipe(Effect.provide(nodeFilePlatformLayer)),
  );
});

describe("evaluation session cleanup", () => {
  it.effect("joins a started deadline abort before publishing prompt completion", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const promptDone = yield* Deferred.make<void>();
      const settled = yield* Deferred.make<void>();
      const run = Effect.runPromiseWith(yield* Effect.context());
      const abort = () =>
        run(Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))));
      const fiber = yield* promptWithDeadline({ abort }, Deferred.await(promptDone)).pipe(
        Effect.ensuring(Deferred.succeed(settled, undefined)),
        Effect.forkChild,
      );
      yield* TestClock.adjust(180_000);
      yield* Deferred.await(started);
      yield* Deferred.succeed(promptDone, undefined);
      yield* Effect.yieldNow;
      expect(yield* Deferred.isDone(settled)).toBe(false);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(fiber)).toEqual({ timedOut: true, promptFailed: false });
    }),
  );

  it.effect("releases sleeping deadlines after success, prompt failure, and interruption", () =>
    Effect.gen(function* () {
      let aborts = 0;
      const run = Effect.runPromiseWith(yield* Effect.context());
      const session = {
        abort: () =>
          run(
            Effect.sync(() => {
              aborts++;
            }),
          ),
      };
      expect(yield* promptWithDeadline(session, Effect.void)).toEqual({
        timedOut: false,
        promptFailed: false,
      });
      expect(yield* promptWithDeadline(session, Effect.fail(evaluationError("prompt")))).toEqual({
        timedOut: false,
        promptFailed: true,
      });
      const fiber = yield* promptWithDeadline(session, Effect.never).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);
      yield* TestClock.adjust(180_000);
      expect(aborts).toBe(0);
    }),
  );

  it.effect(
    "keeps rejected aborts typed and never silently treats them as a timed-out record",
    () =>
      Effect.gen(function* () {
        const promptDone = yield* Deferred.make<void>();
        const run = Effect.runPromiseWith(yield* Effect.context());
        const session = {
          abort: () =>
            run(
              Deferred.succeed(promptDone, undefined).pipe(
                Effect.andThen(Effect.fail(evaluationError("abort"))),
              ),
            ),
        };
        const fiber = yield* promptWithDeadline(session, Deferred.await(promptDone)).pipe(
          Effect.flip,
          Effect.forkChild,
        );
        yield* TestClock.adjust(180_000);
        expect(yield* Fiber.join(fiber)).toMatchObject({
          _tag: "EvaluationError",
          operation: "abort",
        });
      }),
  );

  it.effect("shuts down before disposal and retains typed cleanup failures", () =>
    Effect.gen(function* () {
      for (const failure of [undefined, "abort", "shutdown", "dispose"] as const) {
        const order: string[] = [];
        const step = (name: "abort" | "shutdown"): Promise<void> => {
          order.push(name);
          return name === failure
            ? Promise.reject(new Error("SDK private diagnostic"))
            : Promise.resolve();
        };
        const session = {
          abort: () => step("abort"),
          extensionRunner: { emit: () => step("shutdown") },
          dispose: () => {
            order.push("dispose");
            if (failure === "dispose") throw new Error("SDK private diagnostic");
          },
        };
        if (failure)
          expect(yield* closeSessionEffect(session, () => false).pipe(Effect.flip)).toMatchObject({
            _tag: "EvaluationError",
            operation: failure,
          });
        else yield* closeSessionEffect(session, () => false);
        expect(order).toEqual(["abort", "shutdown", "dispose"]);
      }
    }),
  );
});
