// End-to-end `code_mode` execution through the real vendored runtime over fake Pi definitions:
// exact guest catalog, host limits, cancellation, progress, and diagnostics.
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { CodeMode } from "../src/boundary/codemode-runtime.ts";
import {
  type NestedPiToolDefinitions,
  type PiGuestToolInput,
  type PiGuestToolName,
} from "../src/boundary/host-builtin-tools.ts";
import type { CodeModeConfig } from "../src/config/schema.ts";
import {
  CODE_MODE_UNAVAILABLE_MESSAGE,
  makeCodeModeToolExecute,
  type CodeModeExecutionEnvironment,
} from "../src/tools/execution.ts";
import { MAX_PROGRESS_ENTRIES, type CodeModeToolDetails } from "../src/tools/format.ts";
import { checkSourceSize, clampModelVisibleText, utf8ByteLength } from "../src/tools/limits.ts";
import { codeModeStateFixture, extensionContextFixture } from "./support/host.ts";
import { nestedToolDefinitionsFixture } from "./support/tools.ts";

// JSON here decodes guest results; these are code fixtures under test control.
const guestJson = (text: string) => JSON.parse(text);

/** A foreign nested call that remains pending until Effect interrupts its owning adapter. */
const blockingCall = (onStart?: () => void): Promise<never> => {
  onStart?.();
  return Promise.race([]);
};

const ctx = extensionContextFixture({
  cwd: "/",
  sessionManager: {
    getSessionId: () => "test-session",
    getSessionFile: () => undefined,
  },
  model: undefined,
  thinkingLevel: undefined,
});

interface FakeCall {
  readonly name: string;
  readonly input: PiGuestToolInput;
  readonly signal: AbortSignal | undefined;
}

const fakeDefinitions = (
  impl: Partial<
    Record<
      PiGuestToolName,
      (input: PiGuestToolInput, signal: AbortSignal | undefined) => Promise<string>
    >
  >,
  calls?: FakeCall[],
): NestedPiToolDefinitions => {
  const definition = (name: PiGuestToolName) => ({
    execute: (_id: string, input: PiGuestToolInput, signal?: AbortSignal) => {
      calls?.push({ name, input, signal });
      const handler = impl[name];
      if (handler === undefined) {
        return Promise.reject(new Error(`fake ${name} is not implemented`));
      }
      return handler(input, signal).then((text) => ({
        content: [{ type: "text", text }],
        details: undefined,
      }));
    },
  });
  return nestedToolDefinitionsFixture({
    read: definition("read"),
    bash: definition("bash"),
    edit: definition("edit"),
    write: definition("write"),
    grep: definition("grep"),
    find: definition("find"),
    ls: definition("ls"),
  });
};

interface HarnessOptions {
  readonly config?: Partial<CodeModeConfig>;
  readonly available?: boolean;
  /** Simulates the no-current-state gate: getState() returns undefined. */
  readonly noState?: boolean;
  readonly definitions?: NestedPiToolDefinitions;
  readonly executeCodeMode?: CodeModeExecutionEnvironment["executeCodeMode"];
  readonly isCurrent?: () => boolean;
  readonly runInSession?: CodeModeExecutionEnvironment["runInSession"];
  readonly retainFailureDetails?: CodeModeExecutionEnvironment["retainFailureDetails"];
}

const makeHarness = (options: HarnessOptions = {}) => {
  const state = codeModeStateFixture(options.config, {
    available: options.available ?? true,
  });
  const base = {
    isCurrent: options.isCurrent ?? (() => true),
    getState: () => (options.noState === true ? undefined : state),
    runInSession:
      options.runInSession ??
      ((effect, signal) => Effect.runPromise(effect, signal ? { signal } : undefined)),
    definitions: options.definitions ?? fakeDefinitions({}),
  };
  const execute =
    options.executeCodeMode === undefined
      ? base
      : { ...base, executeCodeMode: options.executeCodeMode };
  const environment =
    options.retainFailureDetails === undefined
      ? execute
      : { ...execute, retainFailureDetails: options.retainFailureDetails };
  return makeCodeModeToolExecute(environment);
};

const textOf = (result: { content: ReadonlyArray<{ type: string; text?: string }> }): string =>
  result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");

describe("guest catalog", () => {
  it.effect("validates canonical non-empty edit input before dispatch", () =>
    Effect.gen(function* () {
      const calls: FakeCall[] = [];
      const definitions = fakeDefinitions({ edit: () => Promise.resolve("should not run") }, calls);
      const execute = makeHarness({ definitions });
      yield* Effect.promise(() =>
        expect(
          execute(
            "call-empty-edit",
            { code: "return await tools.pi.edit({ path: 'x', edits: [] });" },
            undefined,
            undefined,
            ctx,
          ),
        ).rejects.toThrow(/\[InvalidToolInput\]/),
      );
      expect(calls).toHaveLength(0);
    }),
  );

  it.effect("dispatches all seven canonical leaves through fake definitions", () =>
    Effect.gen(function* () {
      const calls: FakeCall[] = [];
      const implemented = (name: PiGuestToolName) => () => Promise.resolve(name);
      const definitions = fakeDefinitions(
        {
          read: implemented("read"),
          bash: implemented("bash"),
          edit: implemented("edit"),
          write: implemented("write"),
          grep: implemented("grep"),
          find: implemented("find"),
          ls: implemented("ls"),
        },
        calls,
      );
      const execute = makeHarness({ definitions });
      const result = yield* Effect.promise(() =>
        execute(
          "call-all-tools",
          {
            code: `
              const values = [];
              values.push(await tools.pi.read({ path: "a" }));
              values.push(await tools.pi.bash({ command: "true" }));
              values.push(await tools.pi.edit({
                path: "a",
                edits: [{ oldText: "before", newText: "after" }]
              }));
              values.push(await tools.pi.write({ path: "a", content: "x" }));
              values.push(await tools.pi.grep({ pattern: "x" }));
              values.push(await tools.pi.find({ pattern: "*" }));
              values.push(await tools.pi.ls({}));
              return values.join(",");
            `,
          },
          undefined,
          undefined,
          ctx,
        ),
      );
      expect(textOf(result)).toBe("read,bash,edit,write,grep,find,ls");
      expect(calls.map((call) => call.name)).toEqual([
        "read",
        "bash",
        "edit",
        "write",
        "grep",
        "find",
        "ls",
      ]);
    }),
  );
});

describe("early-path clamp wiring", () => {
  it.effect("clamps or fixes every early outcome before interpreter work", () =>
    Effect.gen(function* () {
      const code = "return 1;";
      const source = "éé";
      const failure = "🔥".repeat(100);
      interface Case {
        readonly name: string;
        readonly options: HarnessOptions;
        readonly expected: string;
        readonly source?: string;
        readonly returned?: boolean;
        readonly abort?: boolean;
        readonly calls?: number;
      }
      const cases: readonly Case[] = [
        {
          name: "stale",
          options: { isCurrent: () => false },
          expected: CODE_MODE_UNAVAILABLE_MESSAGE,
        },
        { name: "missing", options: { noState: true }, expected: CODE_MODE_UNAVAILABLE_MESSAGE },
        {
          name: "disabled",
          options: { available: false, config: { maxOutputBytes: 13 } },
          expected: clampModelVisibleText(CODE_MODE_UNAVAILABLE_MESSAGE, 13),
        },
        {
          name: "pre-abort",
          options: { config: { maxOutputBytes: 12 } },
          expected: clampModelVisibleText("Execution cancelled.", 12),
          returned: true,
          abort: true,
        },
        {
          name: "source",
          options: { config: { maxSourceBytes: 1, maxOutputBytes: 17 } },
          source,
          expected: clampModelVisibleText(checkSourceSize(source, 1) ?? "", 17),
        },
        {
          name: "session",
          options: {
            config: { maxOutputBytes: 31 },
            runInSession: () => Promise.reject(new Error(failure)),
          },
          expected: clampModelVisibleText(`code_mode execution did not complete: ${failure}`, 31),
          calls: 1,
        },
        {
          name: "zero",
          options: { available: false, config: { maxOutputBytes: 0 } },
          expected: "",
        },
      ];
      for (const testCase of cases) {
        const { name, options, expected } = testCase;
        let runtimeCalls = 0;
        const execute = makeHarness({
          ...options,
          executeCodeMode: (runtimeOptions) => {
            runtimeCalls += 1;
            return CodeMode.execute(runtimeOptions);
          },
        });
        const controller = new AbortController();
        if (testCase.abort === true) controller.abort();
        const settled = yield* Effect.promise(() =>
          execute(
            `call-${name}`,
            { code: testCase.source ?? code },
            controller.signal,
            undefined,
            ctx,
          ).then(
            (result) => ({ _tag: "returned" as const, result }),
            (error) => ({
              _tag: "thrown" as const,
              message: error instanceof Error ? error.message : String(error),
            }),
          ),
        );
        expect(settled._tag, name).toBe(testCase.returned === true ? "returned" : "thrown");
        const text = settled._tag === "returned" ? textOf(settled.result) : settled.message;
        expect(text, name).toBe(expected);
        expect(utf8ByteLength(text), name).toBe(utf8ByteLength(expected));
        expect(text, name).not.toContain("�");
        expect(runtimeCalls, name).toBe(testCase.calls ?? 0);
        if (settled._tag === "returned") expect(settled.result.details.cancelled).toBe(true);
      }
    }),
  );
});

describe("host limits", () => {
  it.effect("wires all runtime limit options from the current configuration", () =>
    Effect.gen(function* () {
      let observedLimits: unknown;
      const execute = makeHarness({
        config: { timeoutMs: 123, maxToolCalls: 4, maxOutputBytes: 567 },
        executeCodeMode: (options) => {
          observedLimits = options.limits;
          return Effect.succeed({ ok: true, value: "ok" });
        },
      });
      const result = yield* Effect.promise(() =>
        execute("call-limits", { code: "return 1;" }, undefined, undefined, ctx),
      );
      expect(textOf(result)).toBe("ok");
      expect(observedLimits).toEqual({ timeoutMs: 123, maxToolCalls: 4, maxOutputBytes: 567 });
    }),
  );

  it.effect("applies timeoutMs as the runtime deadline and aborts in-flight nested calls", () =>
    Effect.gen(function* () {
      const calls: FakeCall[] = [];
      const definitions = fakeDefinitions({ read: () => blockingCall() }, calls);
      const execute = makeHarness({ config: { timeoutMs: 50 }, definitions });
      yield* Effect.promise(() =>
        expect(
          execute(
            "call-timeout",
            { code: "return await tools.pi.read({ path: 'hang' });" },
            undefined,
            undefined,
            ctx,
          ),
        ).rejects.toThrow(/\[TimeoutExceeded\].*50ms/s),
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]?.signal?.aborted).toBe(true);
    }),
  );
});

describe("final model-visible byte bound", () => {
  it.effect("bounds success logs and diagnostic framing", () =>
    Effect.gen(function* () {
      for (const [budget, code, expected] of [
        [
          48,
          "console.log('a log line that is fairly long'); return 'result value here';",
          "returned",
        ],
        [40, "class Oops {}\nreturn 1;", "thrown"],
      ] as const) {
        const settled = yield* Effect.promise(() =>
          makeHarness({ config: { maxOutputBytes: budget } })(
            "call-final-bound",
            { code },
            undefined,
            undefined,
            ctx,
          ).then(
            (result) => ({ _tag: "returned" as const, text: textOf(result) }),
            (error) => ({
              _tag: "thrown" as const,
              text: error instanceof Error ? error.message : String(error),
            }),
          ),
        );
        expect(settled._tag).toBe(expected);
        expect(utf8ByteLength(settled.text)).toBeLessThanOrEqual(budget);
      }
    }),
  );
});

describe("cumulative nested output budget", () => {
  it.effect("charges repeated output-overrun refusals through the real interpreter", () =>
    Effect.gen(function* () {
      const definitions = fakeDefinitions({ read: () => Promise.resolve("12345678") });
      for (const [limit, seed, expected] of [
        [10, true, [2, 0]],
        [0, false, [0, 0]],
      ] as const) {
        const code = `${seed ? "await tools.pi.read({ path: 'seed' });" : ""}
          const lengths = [];
          for (let index = 0; index < 2; index += 1) {
            try { await tools.pi.read({ path: "over" }); }
            catch (error) { lengths.push(error.message.length); }
          }
          return lengths;`;
        const result = yield* Effect.promise(() =>
          makeHarness({
            config: { maxCumulativeChildOutputBytes: limit },
            definitions,
          })(`call-budget-${limit}`, { code }, undefined, undefined, ctx),
        );
        expect(guestJson(textOf(result))).toEqual(expected);
      }
    }),
  );
});

describe("cancellation", () => {
  it.effect("aborts mid-flight executions and their nested calls through the outer signal", () =>
    Effect.gen(function* () {
      const calls: FakeCall[] = [];
      const started = Deferred.makeUnsafe<void>();
      const definitions = fakeDefinitions(
        { read: () => blockingCall(() => void Deferred.doneUnsafe(started, Effect.void)) },
        calls,
      );
      const execute = makeHarness({ definitions });
      const controller = new AbortController();
      const pending = execute(
        "call-abort",
        { code: "return await tools.pi.read({ path: 'hang' });" },
        controller.signal,
        undefined,
        ctx,
      );
      yield* Deferred.await(started);
      controller.abort();
      const result = yield* Effect.promise(() => pending);
      expect(textOf(result)).toBe("Execution cancelled.");
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      expect((result.details as CodeModeToolDetails).cancelled).toBe(true);
      expect(calls[0]?.signal?.aborted).toBe(true);
    }),
  );
});

describe("progress", () => {
  it.effect("keeps high-call cancellation final state isolated from hostile progress updates", () =>
    Effect.gen(function* () {
      const executeCodeMode: NonNullable<CodeModeExecutionEnvironment["executeCodeMode"]> = (
        options,
      ) =>
        Effect.gen(function* () {
          for (let id = 0; id <= 256; id += 1)
            yield* (
              options.onToolCallLifecycle?.({
                id,
                name: "pi.read",
                status: "queued",
              }) ?? Effect.void
            );
          yield* (
            options.onToolCallLifecycle?.({
              id: 256,
              name: "pi.read",
              status: "cancelled",
              started: false,
              durationMs: 1,
            }) ?? Effect.void
          );
          return { ok: true as const, value: "done" };
        });
      const execute = makeHarness({ executeCodeMode });
      const result = yield* Effect.promise(() =>
        execute(
          "call-never-started",
          { code: "return 'done';" },
          undefined,
          (partial) => {
            Reflect.set(partial.details.counts ?? {}, "total", -1);
            Reflect.set(partial.details.toolCalls[0] ?? {}, "tool", "hostile-update");
          },
          ctx,
        ),
      );
      expect(result.details.counts).toMatchObject({
        total: 257,
        queued: 0,
        running: 0,
        succeeded: 0,
        failed: 0,
        cancelled: 257,
      });
      expect(result.details.toolCalls).toHaveLength(MAX_PROGRESS_ENTRIES);
      expect(result.details.toolCalls[0]?.tool).toBe("pi.read");
    }),
  );

  it.live("starts immediately, frame-coalesces fast calls, and stops after settle", () =>
    Effect.gen(function* () {
      const secret = "SECRET-NESTED-OUTPUT";
      const definitions = fakeDefinitions({ read: () => Promise.resolve(secret) });
      const execute = makeHarness({ definitions });
      const updates: Array<{ text: string; details: CodeModeToolDetails }> = [];
      const result = yield* Effect.promise(() =>
        execute(
          "call-progress",
          { code: "return await tools.pi.read({ path: 'a' });" },
          undefined,
          (partial) => {
            updates.push({ text: textOf(partial), details: partial.details });
          },
          ctx,
        ),
      );
      expect(textOf(result)).toBe(secret);
      expect(updates.length).toBeGreaterThanOrEqual(2);
      expect(updates[0]).toMatchObject({
        text: "code_mode: starting",
        details: { toolCalls: [] },
      });
      const callUpdates = updates.slice(1);
      for (const update of callUpdates) {
        expect(update.text).not.toContain(secret);
        expect(update.text).toContain("pi.read");
        expect(update.details.toolCalls[0]?.tool).toBe("pi.read");
      }
      // Admission and the enriched running row bypass extension-side frame coalescing so Pi can
      // include them in its own already-scheduled frame; settlement still flushes the final state.
      expect(callUpdates[0]?.details.toolCalls[0]?.status).toBe("queued");
      expect(callUpdates.some((update) => update.details.toolCalls[0]?.status === "running")).toBe(
        true,
      );
      expect(callUpdates.at(-1)?.details.toolCalls[0]?.status).toBe("completed");
    }),
  );

  it.effect(
    "falls back to legacy start/end hooks when a reload-cached runtime emits no lifecycle events",
    () =>
      Effect.gen(function* () {
        const definitions = fakeDefinitions({ read: () => Promise.resolve("legacy-data") });
        const executeCodeMode: NonNullable<CodeModeExecutionEnvironment["executeCodeMode"]> = (
          options,
        ) => {
          const { onToolCallLifecycle: _ignored, ...legacyOptions } = options;
          return CodeMode.execute(legacyOptions);
        };
        const execute = makeHarness({ definitions, executeCodeMode });
        const result = yield* Effect.promise(() =>
          execute(
            "call-legacy-runtime",
            { code: "return await tools.pi.read({ path: 'legacy.txt' });" },
            undefined,
            undefined,
            ctx,
          ),
        );
        expect(textOf(result)).toBe("legacy-data");
        expect(result.details.counts).toMatchObject({ total: 1, succeeded: 1 });
        expect(result.details.toolCalls).toEqual([
          expect.objectContaining({
            tool: "pi.read",
            status: "completed",
            activity: "Read legacy.txt",
          }),
        ]);
      }),
  );
});

describe("diagnostics and errors", () => {
  it.effect("charges catchable nested failure text to the cumulative child-output budget", () =>
    Effect.gen(function* () {
      const definitions = fakeDefinitions({
        bash: () => Promise.reject(new Error("failure-" + "x".repeat(1_000))),
      });
      const execute = makeHarness({
        definitions,
        config: { maxCumulativeChildOutputBytes: 48 },
      });
      const result = yield* Effect.promise(() =>
        execute(
          "call-bounded-error",
          {
            code: `
          try {
            await tools.pi.bash({ command: "false" });
            return "unexpected";
          } catch (error) {
            return { message: error.message, length: error.message.length };
          }
        `,
          },
          undefined,
          undefined,
          ctx,
        ),
      );
      // SAFETY: The test controls the serialized fixture and asserts the exact decoded contract below.
      const observed = guestJson(textOf(result)) as { message: string; length: number };
      expect(observed.length).toBeLessThanOrEqual(48);
      expect(observed.message).toContain("Nested tool 'bash' failed");
      expect(observed.message).not.toContain("x".repeat(100));
    }),
  );

  it.effect("retains settled lifecycle details before an uncaught runtime failure is thrown", () =>
    Effect.gen(function* () {
      const retained: Array<{ id: string; details: CodeModeToolDetails }> = [];
      const definitions = fakeDefinitions({
        read: () => Promise.reject(new Error("missing fixture")),
      });
      const execute = makeHarness({
        definitions,
        retainFailureDetails: (id, details) => retained.push({ id, details }),
      });
      yield* Effect.promise(() =>
        expect(
          execute(
            "call-retained-failure",
            { code: `return await tools.pi.read({ path: "missing" });` },
            undefined,
            undefined,
            ctx,
          ),
        ).rejects.toThrow(/ToolFailure/),
      );
      expect(retained).toHaveLength(1);
      expect(retained[0]?.id).toBe("call-retained-failure");
      expect(retained[0]?.details.toolCalls[0]?.status).toBe("error");
      expect(retained[0]?.details.counts).toMatchObject({ total: 1, failed: 1 });
    }),
  );
});
