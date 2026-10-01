import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { CodeModeResult } from "../../src/engine/diagnostic.ts";
import type { ToolCallLifecycleEvent } from "../../src/engine/dispatch.ts";
import { executeProgram, type ExecutionLimits } from "../../src/engine/execute.ts";
import { makeTool, toolError } from "../../src/engine/tool.ts";
import { temporaryDirectory, yieldUntil } from "pi-cosmic-core/testing";
import { childFrame, programProcessFixture } from "../support/execute.ts";

const limits: ExecutionLimits = { timeoutMs: 10_000, maxToolCalls: 32, maxOutputBytes: 50_000 };

const tools = {
  demo: {
    echo: makeTool({
      description: "Echo text back",
      input: Schema.Struct({ text: Schema.String }),
      output: Schema.String,
      run: ({ text }) => Effect.succeed(`echo:${text}`),
    }),
    slow: makeTool({
      description: "Answer after a delay",
      input: Schema.Struct({ ms: Schema.Number, text: Schema.String }),
      output: Schema.String,
      run: ({ ms, text }) => Effect.as(Effect.sleep(ms), text),
    }),
    fail: makeTool({
      description: "Always fails",
      input: Schema.Struct({}),
      run: () => Effect.fail(toolError("nope")),
    }),
    bigint: makeTool({
      description: "Returns data that is not JSON",
      input: Schema.Struct({}),
      run: () => Effect.succeed({ value: 1n }),
    }),
  },
};

const run = (code: string, overrides: Partial<ExecutionLimits> = {}, cwd = process.cwd()) => {
  const events: Array<ToolCallLifecycleEvent> = [];
  return executeProgram({
    code,
    cwd,
    tools,
    limits: { ...limits, ...overrides },
    onToolCallLifecycle: (event) => Effect.sync(() => void events.push(event)),
  }).pipe(Effect.map((result) => ({ result, events })));
};

const failed = (result: CodeModeResult) => {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a failed result");
  return result;
};

const terminal = (events: ReadonlyArray<ToolCallLifecycleEvent>) =>
  events.flatMap((event) =>
    event.status === "queued" || event.status === "running"
      ? []
      : [`${event.name}:${event.status}`],
  );

const returned = childFrame({
  type: "result",
  ok: true,
  format: "text",
  text: "done",
  totalBytes: 4,
});

type DemoCallInput = { readonly text: string } | Record<string, never>;

const called = (seq: number, tool: "echo" | "pending", input: DemoCallInput) =>
  childFrame({ type: "call", seq, path: ["demo", tool], args: [input] });

const parentFrameText = (bytes: Uint8Array) => new TextDecoder().decode(bytes.subarray(4));

describe.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "owned execution lifetime",
  () => {
    for (const stage of ["before acquisition", "acquired readiness", "start write"] as const) {
      it.effect(
        `times out during ${stage} without releasing its pause or dispatching late work`,
        () =>
          Effect.gen(function* () {
            const entered = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            const pause = Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
            );
            let acquired = 0;
            let released = 0;
            const writes: Array<string> = [];
            const events: Array<ToolCallLifecycleEvent> = [];
            const captures: Array<CodeModeResult> = [];
            const fiber = yield* executeProgram({
              code: "return 'done';",
              cwd: process.cwd(),
              tools,
              limits: { ...limits, timeoutMs: 10 },
              onResult: (result) => void captures.push(result),
              onToolCallLifecycle: (event) => Effect.sync(() => void events.push(event)),
              openProcess: (options) =>
                Effect.gen(function* () {
                  if (stage === "before acquisition") yield* pause;
                  const child = yield* Effect.acquireRelease(
                    Effect.sync(() => {
                      acquired++;
                      return programProcessFixture({
                        stdout: Stream.make(called(0, "echo", { text: "late" }), returned),
                        write: (bytes) =>
                          Effect.gen(function* () {
                            if (
                              stage === "start write" &&
                              parentFrameText(bytes).includes('"type":"start"')
                            )
                              yield* pause;
                            writes.push(parentFrameText(bytes));
                          }),
                      });
                    }),
                    () =>
                      Effect.sync(() => {
                        released++;
                        options.onCleanup(true);
                      }),
                  );
                  if (stage === "acquired readiness") yield* pause;
                  return child;
                }),
            }).pipe(Effect.forkChild);
            yield* Deferred.await(entered);
            yield* TestClock.adjust(10);
            yield* yieldUntil(() => fiber.pollUnsafe() !== undefined);
            const result = yield* Fiber.join(fiber);
            expect(failed(result).error.kind).toBe("TimeoutExceeded");
            expect(acquired).toBe(stage === "before acquisition" ? 0 : 1);
            expect(released).toBe(acquired);
            expect(writes).toEqual([]);
            expect(events).toEqual([]);
            expect(captures).toEqual([result]);
            yield* Deferred.succeed(release, undefined);
            yield* Effect.yieldNow;
            expect(writes).toEqual([]);
            expect(events).toEqual([]);
            expect(captures).toEqual([result]);
            expect(released).toBe(acquired);
          }),
      );
    }

    it.effect("refuses an already expired start even when a successful result is buffered", () =>
      Effect.gen(function* () {
        let opened = 0;
        const result = yield* executeProgram({
          code: "return 'done';",
          cwd: process.cwd(),
          tools,
          limits: { ...limits, timeoutMs: 0 },
          openProcess: () =>
            Effect.sync(() => {
              opened++;
              return programProcessFixture({ stdout: Stream.make(returned) });
            }),
        });
        expect(failed(result).error.kind).toBe("TimeoutExceeded");
        expect(opened).toBe(0);
      }),
    );

    it.effect("bounds delayed finish delivery with a separate post-result output allowance", () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let released = 0;
        let finishDelivered = false;
        const captures: Array<CodeModeResult> = [];
        const fiber = yield* executeProgram({
          code: "return 'done';",
          cwd: process.cwd(),
          tools,
          limits: { ...limits, timeoutMs: 10 },
          onResult: (result) => void captures.push(result),
          openProcess: () =>
            Effect.acquireRelease(
              Effect.succeed(
                programProcessFixture({
                  stdout: Stream.make(returned),
                  write: (bytes) =>
                    parentFrameText(bytes).includes('"type":"finish"')
                      ? Deferred.succeed(entered, undefined).pipe(
                          Effect.andThen(Deferred.await(release)),
                          Effect.andThen(
                            Effect.sync(() => {
                              finishDelivered = true;
                            }),
                          ),
                        )
                      : Effect.void,
                }),
              ),
              () =>
                Effect.sync(() => {
                  released++;
                }),
            ),
        }).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* TestClock.adjust(10);
        expect(fiber.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust(240);
        yield* yieldUntil(() => fiber.pollUnsafe() !== undefined);
        const result = yield* Fiber.join(fiber);
        expect(result).toEqual({ ok: true, value: "done" });
        expect(released).toBe(1);
        expect(finishDelivered).toBe(false);
        expect(captures).toEqual([result]);
        yield* Deferred.succeed(release, undefined);
        yield* Effect.yieldNow;
        expect(finishDelivered).toBe(false);
        expect(captures).toEqual([result]);
      }),
    );

    it.effect(
      "refuses a late start after masked acquisition settles and releases ownership once",
      () =>
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          let writes = 0;
          let released = 0;
          const fiber = yield* executeProgram({
            code: "return 'done';",
            cwd: process.cwd(),
            tools,
            limits: { ...limits, timeoutMs: 10 },
            openProcess: () =>
              Effect.uninterruptible(
                Effect.gen(function* () {
                  const child = yield* Effect.acquireRelease(
                    Effect.succeed(
                      programProcessFixture({
                        stdout: Stream.make(returned),
                        write: () =>
                          Effect.sync(() => {
                            writes++;
                          }),
                      }),
                    ),
                    () =>
                      Effect.sync(() => {
                        released++;
                      }),
                  );
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(release);
                  return child;
                }),
              ),
          }).pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          yield* TestClock.adjust(10);
          expect(fiber.pollUnsafe()).toBeUndefined();
          yield* Deferred.succeed(release, undefined);
          expect(failed(yield* Fiber.join(fiber)).error.kind).toBe("TimeoutExceeded");
          expect(writes).toBe(0);
          expect(released).toBe(1);
        }),
    );

    it.effect(
      "keeps finalization outside the deadline and retains uncertain cleanup evidence",
      () =>
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const cleanupEntered = yield* Deferred.make<void>();
          const cleanupRelease = yield* Deferred.make<void>();
          const captures: Array<CodeModeResult> = [];
          let releases = 0;
          const fiber = yield* executeProgram({
            code: "return 'done';",
            cwd: process.cwd(),
            tools,
            limits: { ...limits, timeoutMs: 10 },
            onResult: (result) => void captures.push(result),
            openProcess: (options) =>
              Effect.acquireRelease(
                Effect.succeed(
                  programProcessFixture({
                    write: () =>
                      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
                  }),
                ),
                () =>
                  Effect.gen(function* () {
                    releases++;
                    yield* Deferred.succeed(cleanupEntered, undefined);
                    yield* Deferred.await(cleanupRelease);
                    options.onCleanup(false);
                  }),
              ),
          }).pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          yield* TestClock.adjust(10);
          yield* Deferred.await(cleanupEntered);
          yield* TestClock.adjust(10_000);
          expect(fiber.pollUnsafe()).toBeUndefined();
          expect(captures).toEqual([]);
          yield* Deferred.succeed(cleanupRelease, undefined);
          const result = yield* Fiber.join(fiber);
          expect(failed(result).error.kind).toBe("TimeoutExceeded");
          expect(result.logs?.join(" ")).toContain("could not confirm");
          expect(releases).toBe(1);
          expect(captures).toEqual([result]);
        }),
    );

    for (const ending of ["EOF", "malformed frame"] as const) {
      it.effect(`reports ${ending} and cancels pending dispatch before the deadline`, () =>
        Effect.gen(function* () {
          const completed = yield* Deferred.make<void>();
          const pending = yield* Deferred.make<void>();
          const events: Array<ToolCallLifecycleEvent> = [];
          let released = 0;
          const stdout = Stream.make(called(0, "echo", { text: "retained" })).pipe(
            Stream.concat(Stream.fromEffect(Deferred.await(completed)).pipe(Stream.drain)),
            Stream.concat(Stream.make(called(1, "pending", {}))),
            Stream.concat(Stream.fromEffect(Deferred.await(pending)).pipe(Stream.drain)),
            Stream.concat(
              ending === "EOF" ? Stream.empty : Stream.make(new Uint8Array([0, 0, 0, 1, 255])),
            ),
          );
          const fiber = yield* executeProgram({
            code: "await tools.demo.pending({});",
            cwd: process.cwd(),
            limits,
            tools: {
              demo: {
                echo: tools.demo.echo,
                pending: makeTool({
                  description: "Pending dispatch",
                  input: Schema.Struct({}),
                  run: () =>
                    Deferred.succeed(pending, undefined).pipe(Effect.andThen(Effect.never)),
                }),
              },
            },
            onToolCallLifecycle: (event) =>
              Effect.sync(() => void events.push(event)).pipe(
                Effect.andThen(
                  event.name === "demo.echo" && event.status === "succeeded"
                    ? Effect.asVoid(Deferred.succeed(completed, undefined))
                    : Effect.void,
                ),
              ),
            openProcess: () =>
              Effect.acquireRelease(
                Effect.succeed(
                  programProcessFixture({
                    stdout,
                    exit: Effect.succeed({ code: 3, signal: null }),
                  }),
                ),
                () =>
                  Effect.sync(() => {
                    released++;
                  }),
              ),
          }).pipe(Effect.forkChild);
          yield* Deferred.await(pending);
          yield* yieldUntil(() => fiber.pollUnsafe() !== undefined);
          const result = failed(yield* Fiber.join(fiber));
          expect(result.error.kind).toBe("ExecutionFailure");
          expect(result.error.message).toContain(
            ending === "EOF" ? "exit code 3" : "invalid Code Mode message",
          );
          expect(result.completed).toEqual([{ tool: "tools.demo.echo", text: "echo:retained" }]);
          expect(terminal(events)).toEqual(["demo.echo:succeeded", "demo.pending:cancelled"]);
          expect(yield* Clock.currentTimeMillis).toBe(0);
          expect(released).toBe(1);
        }),
      );
    }

    for (const stalled of ["exit", "stderr"] as const) {
      it.effect(`cancels running and queued calls on EOF before the stalled ${stalled} tail`, () =>
        Effect.gen(function* () {
          const running = yield* Deferred.make<void>();
          const queued = yield* Deferred.make<void>();
          const eof = yield* Deferred.make<void>();
          const tailEntered = yield* Deferred.make<void>();
          const events: Array<ToolCallLifecycleEvent> = [];
          let started = 0;
          let sideEffects = 0;
          let releases = 0;
          const fiber = yield* executeProgram({
            code: "await tools.demo.pending({});",
            cwd: process.cwd(),
            limits,
            tools: {
              demo: {
                pending: makeTool({
                  description: "Side effect after a delay",
                  input: Schema.Struct({}),
                  run: () =>
                    Effect.gen(function* () {
                      started++;
                      if (started === 8) yield* Deferred.succeed(running, undefined);
                      yield* Effect.sleep(100);
                      sideEffects++;
                    }),
                }),
              },
            },
            onToolCallLifecycle: (event) =>
              Effect.sync(() => void events.push(event)).pipe(
                Effect.andThen(
                  event.id === 8 && event.status === "queued"
                    ? Effect.asVoid(Deferred.succeed(queued, undefined))
                    : Effect.void,
                ),
              ),
            openProcess: () =>
              Effect.acquireRelease(
                Effect.succeed(
                  programProcessFixture({
                    stdout: Stream.make(
                      ...Array.from({ length: 9 }, (_, id) => called(id, "pending", {})),
                    ).pipe(
                      Stream.concat(Stream.fromEffect(Deferred.await(eof)).pipe(Stream.drain)),
                    ),
                    stderr: Stream.fromEffect(Effect.never),
                    exit: Deferred.succeed(tailEntered, undefined).pipe(
                      Effect.andThen(
                        stalled === "exit"
                          ? Effect.never
                          : Effect.succeed({ code: 3, signal: null }),
                      ),
                    ),
                  }),
                ),
                () =>
                  Effect.sync(() => {
                    releases++;
                  }),
              ),
          }).pipe(Effect.forkChild);
          yield* Deferred.await(running);
          yield* Deferred.await(queued);
          expect(started).toBe(8);
          yield* Deferred.succeed(eof, undefined);
          // Cancellation is observable before advancing any output-tail time.
          yield* yieldUntil(() => terminal(events).length === 9);
          yield* Deferred.await(tailEntered);
          expect(events.filter((event) => event.status === "running")).toHaveLength(8);
          expect(terminal(events)).toEqual(Array(9).fill("demo.pending:cancelled"));
          expect(yield* Clock.currentTimeMillis).toBe(0);
          expect(fiber.pollUnsafe()).toBeUndefined();
          expect(releases).toBe(0);
          yield* TestClock.adjust(100);
          expect(sideEffects).toBe(0);
          expect(started).toBe(8);
          expect(fiber.pollUnsafe()).toBeUndefined();
          yield* TestClock.adjust(150);
          const result = failed(yield* Fiber.join(fiber));
          expect(result.error.kind).toBe("ExecutionFailure");
          expect(result.error.message).toContain("exited before returning a result");
          expect(sideEffects).toBe(0);
          expect(started).toBe(8);
          expect(releases).toBe(1);
        }),
      );
    }

    it.effect("preserves EOF through delayed dispatch finalization outside both time budgets", () =>
      Effect.gen(function* () {
        const running = yield* Deferred.make<void>();
        const queued = yield* Deferred.make<void>();
        const eof = yield* Deferred.make<void>();
        const finalizerEntered = yield* Deferred.make<void>();
        const finalizerRelease = yield* Deferred.make<void>();
        const tailEntered = yield* Deferred.make<void>();
        const events: Array<ToolCallLifecycleEvent> = [];
        const captures: Array<CodeModeResult> = [];
        let started = 0;
        let finalizations = 0;
        let releases = 0;
        const fiber = yield* executeProgram({
          code: "await tools.demo.pending({});",
          cwd: process.cwd(),
          limits: { ...limits, timeoutMs: 10 },
          tools: {
            demo: {
              pending: makeTool({
                description: "Owned dispatch with a delayed finalizer",
                input: Schema.Struct({}),
                run: () =>
                  Effect.suspend(() => {
                    const first = started++ === 0;
                    return (
                      started === 8
                        ? Effect.asVoid(Deferred.succeed(running, undefined))
                        : Effect.void
                    ).pipe(
                      Effect.andThen(Effect.never),
                      Effect.ensuring(
                        Effect.sync(() => {
                          finalizations++;
                        }).pipe(
                          Effect.andThen(
                            first
                              ? Deferred.succeed(finalizerEntered, undefined).pipe(
                                  Effect.andThen(Deferred.await(finalizerRelease)),
                                )
                              : Effect.void,
                          ),
                        ),
                      ),
                    );
                  }),
              }),
            },
          },
          onResult: (result) => void captures.push(result),
          onToolCallLifecycle: (event) =>
            Effect.sync(() => void events.push(event)).pipe(
              Effect.andThen(
                event.id === 8 && event.status === "queued"
                  ? Effect.asVoid(Deferred.succeed(queued, undefined))
                  : Effect.void,
              ),
            ),
          openProcess: (options) =>
            Effect.acquireRelease(
              Effect.succeed(
                programProcessFixture({
                  stdout: Stream.make(
                    ...Array.from({ length: 9 }, (_, id) => called(id, "pending", {})),
                  ).pipe(Stream.concat(Stream.fromEffect(Deferred.await(eof)).pipe(Stream.drain))),
                  stderr: Stream.fromEffect(Effect.never),
                  exit: Deferred.succeed(tailEntered, undefined).pipe(Effect.andThen(Effect.never)),
                }),
              ),
              () =>
                Effect.sync(() => {
                  releases++;
                  options.onCleanup(false);
                }),
            ),
        }).pipe(Effect.forkChild);
        yield* Deferred.await(running);
        yield* Deferred.await(queued);
        yield* Deferred.succeed(eof, undefined);
        yield* Deferred.await(finalizerEntered);
        // A slow active finalizer cannot let the queued ninth call acquire a freed permit.
        yield* yieldUntil(() =>
          events.some((event) => event.id === 8 && event.status === "cancelled"),
        );
        yield* TestClock.adjust(10_000);
        expect(started).toBe(8);
        expect(finalizations).toBe(8);
        expect(fiber.pollUnsafe()).toBeUndefined();
        expect(releases).toBe(0);
        expect(captures).toEqual([]);
        expect(yield* Deferred.isDone(tailEntered)).toBe(false);
        yield* Deferred.succeed(finalizerRelease, undefined);
        yield* Deferred.await(tailEntered);
        yield* TestClock.adjust(250);
        const result = failed(yield* Fiber.join(fiber));
        expect(result.error.kind).toBe("ExecutionFailure");
        expect(result.error.message).toContain("exited before returning a result");
        expect(result.logs?.join(" ")).toContain("could not confirm");
        expect(terminal(events)).toEqual(Array(9).fill("demo.pending:cancelled"));
        expect(started).toBe(8);
        expect(finalizations).toBe(8);
        expect(releases).toBe(1);
        expect(captures).toEqual([result]);
      }),
    );

    it.effect(
      "joins pending sibling dispatches for a valid result instead of cancelling them",
      () =>
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const resultSent = yield* Deferred.make<void>();
          const events: Array<ToolCallLifecycleEvent> = [];
          const fiber = yield* executeProgram({
            code: "return 'done';",
            cwd: process.cwd(),
            limits,
            tools: {
              demo: {
                pending: makeTool({
                  description: "Pending sibling",
                  input: Schema.Struct({}),
                  run: () =>
                    Deferred.succeed(entered, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                      Effect.as("sibling"),
                    ),
                }),
              },
            },
            onToolCallLifecycle: (event) => Effect.sync(() => void events.push(event)),
            openProcess: () =>
              Effect.succeed(
                programProcessFixture({
                  stdout: Stream.make(called(0, "pending", {})).pipe(
                    Stream.concat(
                      Stream.fromEffect(
                        Deferred.await(entered).pipe(
                          Effect.andThen(Deferred.succeed(resultSent, undefined)),
                          Effect.as(returned),
                        ),
                      ),
                    ),
                  ),
                }),
              ),
          }).pipe(Effect.forkChild);
          yield* Deferred.await(resultSent);
          yield* Effect.yieldNow;
          expect(fiber.pollUnsafe()).toBeUndefined();
          expect(terminal(events)).toEqual([]);
          yield* Deferred.succeed(release, undefined);
          expect(yield* Fiber.join(fiber)).toEqual({ ok: true, value: "done" });
          expect(terminal(events)).toEqual(["demo.pending:succeeded"]);
        }),
    );
  },
);

describe.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "native program execution",
  () => {
    it.live("returns strings verbatim, JSON values as data, and console output as logs", () =>
      Effect.gen(function* () {
        const text = yield* run(`console.log("out"); console.error("err"); return "a\\n{b}";`);
        expect(text.result).toEqual({ ok: true, value: "a\n{b}", logs: ["out", "err"] });
        const data = yield* run(
          `return { when: new Date(0), list: [1, undefined], gone: undefined };`,
        );
        expect(data.result).toEqual({
          ok: true,
          value: { when: "1970-01-01T00:00:00.000Z", list: [1, null] },
        });
        const nothing = yield* run(`const x = 1;`);
        expect(nothing.result).toEqual({ ok: true, value: null });
      }),
    );

    it.live("runs tool calls in parallel and reports each call's lifecycle", () =>
      Effect.gen(function* () {
        const { result, events } = yield* run(
          `return await Promise.all(["a", "b", "c"].map((text) => tools.demo.echo({ text })));`,
        );
        expect(result).toEqual({ ok: true, value: ["echo:a", "echo:b", "echo:c"] });
        expect(terminal(events).sort()).toEqual([
          "demo.echo:succeeded",
          "demo.echo:succeeded",
          "demo.echo:succeeded",
        ]);
      }),
    );

    it.live("lets siblings of a failed Promise.all finish and returns their output", () =>
      Effect.gen(function* () {
        const { result, events } = yield* run(
          `await Promise.all([tools.demo.slow({ ms: 150, text: "late" }), tools.demo.fail({})]);`,
        );
        const failure = failed(result);
        expect(failure.error.kind).toBe("ToolFailure");
        expect(failure.error.facts?.tool).toBe("demo.fail");
        expect(failure.error.location?.line).toBe(1);
        expect(terminal(events).sort()).toEqual(["demo.fail:failed", "demo.slow:succeeded"]);
        expect(failure.completed).toEqual([{ tool: "tools.demo.slow", text: "late" }]);
      }),
    );

    it.live("keeps a successful result when the program catches a tool failure", () =>
      Effect.gen(function* () {
        const { result } = yield* run(
          `try { await tools.demo.fail({}); } catch (error) { return [error.name, error.message]; }`,
        );
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value).toEqual(["ToolError", expect.stringContaining("nope")]);
      }),
    );

    it.live("fails a program that leaves a tool rejection unhandled", () =>
      Effect.gen(function* () {
        const { result } = yield* run(`tools.demo.fail({}); return "done";`);
        const failure = failed(result);
        expect(failure.error.kind).toBe("ToolFailure");
        expect(failure.error.message).toMatch(/un-awaited/u);
      }),
    );

    it.live("refuses unknown tools, invalid input and calls past the limit before dispatch", () =>
      Effect.gen(function* () {
        const unknown = failed((yield* run(`await tools.demo.ech0({ text: "x" });`)).result);
        expect(unknown.error.kind).toBe("UnknownTool");
        expect(unknown.error.suggestions?.join(" ")).toContain("tools.demo.echo");

        const invalid = failed((yield* run(`await tools.demo.echo({ text: 1 });`)).result);
        expect(invalid.error.kind).toBe("InvalidToolInput");
        expect(invalid.error.facts?.field).toEqual(["text"]);

        const limited = yield* run(
          `for (const text of ["a", "b"]) await tools.demo.echo({ text });`,
          { maxToolCalls: 1 },
        );
        expect(failed(limited.result).error.kind).toBe("ToolCallLimitExceeded");
        expect(terminal(limited.events)).toEqual(["demo.echo:succeeded", "demo.echo:failed"]);
      }),
    );

    it.live("reports syntax errors with their location and accepts TypeScript types", () =>
      Effect.gen(function* () {
        const syntax = failed((yield* run(`const ok = 1;\nconst broken = ;`)).result);
        expect(syntax.error.kind).toBe("ParseError");
        expect(syntax.error.location).toEqual({ line: 2, column: 16 });

        const typed = yield* run(
          `const add = (a: number, b: number): number => a + b;\nreturn add(1, 2) as number;`,
        );
        expect(typed.result).toEqual({ ok: true, value: 3 });
      }),
    );

    it.live("runs in the session directory with Node built-ins", () =>
      Effect.gen(function* () {
        const cwd = yield* temporaryDirectory("code-mode-cwd-");
        const { result } = yield* run(
          `const { createHash } = await import("node:crypto");\nreturn [process.cwd().split("/").pop(), createHash("sha1").update("x").digest("hex").length];`,
          {},
          cwd,
        );
        expect(result).toEqual({ ok: true, value: [cwd.split("/").pop(), 40] });
      }).pipe(Effect.scoped),
    );

    it.live("routes network requests through tools", () =>
      Effect.gen(function* () {
        const refused = (code: string) =>
          run(code).pipe(Effect.map(({ result }) => failed(result).error));
        const requests = [
          `await fetch("http://127.0.0.1:9");`,
          `new WebSocket("ws://127.0.0.1:9");`,
          // Only Node 25+ can refuse sockets and DNS; it knows the flag that would allow them.
          ...(process.allowedNodeEnvironmentFlags.has("--allow-net")
            ? [
                `const net = await import("node:net");\nawait new Promise((connected, failed) => net.connect(9, "127.0.0.1").on("connect", connected).on("error", failed));`,
                `const http = await import("node:http");\nhttp.createServer().listen(0);`,
                `const dns = await import("node:dns/promises");\nawait dns.lookup("localhost");`,
              ]
            : []),
        ];
        for (const request of requests) {
          const error = yield* refused(request);
          expect(error.message).toContain("tools.pi.bash");
          expect(error.message).toContain("network");
        }
      }),
    );

    it.live("routes file reads, writes, imports and processes through tools", () =>
      Effect.gen(function* () {
        const refused = (code: string) =>
          run(code).pipe(Effect.map(({ result }) => failed(result).error));
        const read = yield* refused(
          `const { readFile } = await import("node:fs/promises");\nawait readFile("package.json", "utf8");`,
        );
        expect(read.message).toContain("tools.pi.read");
        expect(read.message).toContain("package.json");
        expect(read.location?.line).toBe(2);
        const write = yield* refused(
          `const { writeFile } = await import("node:fs/promises");\nawait writeFile("x.txt", "x");`,
        );
        expect(write.message).toContain("tools.pi.write");
        expect(write.message).toContain("x.txt");
        const bare = yield* refused(`await import("effect");`);
        expect(bare.message).toContain('"effect" package');
        const relative = yield* refused(`await import("./src/engine/tool.ts");`);
        expect(relative.message).toContain("src/engine/tool.ts");
        const spawned = yield* refused(
          `const { execSync } = await import("node:child_process");\nexecSync("true");`,
        );
        expect(spawned.message).toContain("tools.pi.bash");
      }),
    );

    it.live("refuses values that are not JSON at both boundaries", () =>
      Effect.gen(function* () {
        const returned = failed((yield* run(`return { n: 1n };`)).result);
        expect(returned.error.kind).toBe("InvalidDataValue");
        const output = failed((yield* run(`return await tools.demo.bigint({});`)).result);
        expect(output.error.kind).toBe("InvalidToolOutput");
        const input = failed(
          (yield* run(`const a = {}; a.self = a; await tools.demo.echo(a);`)).result,
        );
        expect(input.error.kind).toBe("InvalidDataValue");
      }),
    );

    it.live("fails at once when the program awaits something nothing can settle", () =>
      Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis;
        const stalled = failed(
          (yield* run(`await new Promise(() => {});\nreturn "unreachable";`, { timeoutMs: 20_000 }))
            .result,
        );
        expect(stalled.error.kind).toBe("ExecutionFailure");
        expect(stalled.error.message).toMatch(/stalled/u);
        expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(10_000);

        // A call still running keeps the program alive; the stall is reported once it settles.
        const afterCall = yield* run(
          `tools.demo.slow({ ms: 200, text: "late" });\nawait new Promise(() => {});`,
          { timeoutMs: 20_000 },
        );
        expect(failed(afterCall.result).error.message).toMatch(/stalled/u);
        expect(terminal(afterCall.events)).toEqual(["demo.slow:succeeded"]);
      }),
    );

    it.live("does not treat pending timers as a stall", () =>
      Effect.gen(function* () {
        const timer = yield* run(
          `await new Promise((resolve) => setTimeout(resolve, 200));\nreturn "waited";`,
        );
        expect(timer.result).toEqual({ ok: true, value: "waited" });
        // An interval can always wake the program, so only the deadline ends it.
        const interval = yield* run(`setInterval(() => {}, 1000);\nawait new Promise(() => {});`, {
          timeoutMs: 2_000,
        });
        expect(failed(interval.result).error.kind).toBe("TimeoutExceeded");
      }),
    );

    it.live("stops a looping program at the deadline", () =>
      Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis;
        const { result } = yield* run(`console.log("spinning"); while (true) {}`, {
          timeoutMs: 2_000,
        });
        const failure = failed(result);
        expect(failure.error.kind).toBe("TimeoutExceeded");
        expect(failure.logs).toEqual(["spinning"]);
        expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(5_000);
      }),
    );

    it.live("cancels calls still running at the deadline", () =>
      Effect.gen(function* () {
        const { result, events } = yield* run(`await tools.demo.slow({ ms: 5_000, text: "x" });`, {
          timeoutMs: 2_000,
        });
        expect(failed(result).error.kind).toBe("TimeoutExceeded");
        expect(terminal(events)).toEqual(["demo.slow:cancelled"]);
      }),
    );

    it.live("stops promptly when interrupted", () =>
      Effect.gen(function* () {
        const fiber = yield* run(`while (true) {}`).pipe(Effect.forkChild);
        yield* Effect.sleep(200);
        const started = yield* Clock.currentTimeMillis;
        yield* Fiber.interrupt(fiber);
        expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(3_000);
      }),
    );

    it.live("reports a process that exits before returning", () =>
      Effect.gen(function* () {
        const { result } = yield* run(`process.exit(3);`);
        const failure = failed(result);
        expect(failure.error.kind).toBe("ExecutionFailure");
        expect(failure.error.message).toContain("exit code 3");
      }),
    );

    it.live("refuses tool calls made after the program returned", () =>
      Effect.gen(function* () {
        const { result, events } = yield* run(
          `setTimeout(() => tools.demo.echo({ text: "late" }).catch(() => {}), 50);\nreturn "early";`,
        );
        expect(result).toEqual({ ok: true, value: "early" });
        expect(events).toEqual([]);
      }),
    );

    it.live("keeps a result whose JSON escaping outgrows the frame limit", () =>
      Effect.gen(function* () {
        const { result } = yield* run(`return "\\n".repeat(10 * 1024 * 1024);`, {
          maxOutputBytes: 100,
        });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.truncated).toBe(true);
      }),
    );

    it.live("bounds oversized results and marks them truncated", () =>
      Effect.gen(function* () {
        const { result } = yield* run(`return "x".repeat(10_000);`, { maxOutputBytes: 200 });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.truncated).toBe(true);
          expect(String(result.value)).toMatch(/result truncated/u);
        }
      }),
    );
  },
);
