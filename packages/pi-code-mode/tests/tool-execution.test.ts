// End-to-end `code_mode` execution through the real vendored runtime over fake Pi definitions:
// exact guest catalog, host limits, cancellation, progress, and diagnostics.
import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import {
  BACKGROUND_TASK_CODE_MODE_QUERY,
  BACKGROUND_TASK_CODE_MODE_VERSION,
  normalizeBackgroundTaskCodeModeQuery,
  type BackgroundTaskCodeModeCapability,
} from "pi-background-task/code-mode";
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

const inertEvents = createEventBus();

const backgroundEvents = (
  capabilities: ReadonlyArray<BackgroundTaskCodeModeCapability>,
): ExtensionAPI["events"] => {
  const events = createEventBus();
  events.on(BACKGROUND_TASK_CODE_MODE_QUERY, (value) => {
    const query = normalizeBackgroundTaskCodeModeQuery(value);
    if (!query) return;
    for (const capability of capabilities) query.respond(capability);
  });
  return events;
};

const backgroundSnapshot = {
  id: "bg-1",
  command: "dev-server",
  cwd: "/project",
  state: "running" as const,
  pid: 42,
  startedAt: 1,
  logCursor: 0,
  droppedLogBytes: 0,
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
  const portable = {
    read: definition("read"),
    bash: definition("bash"),
    edit: definition("edit"),
    write: definition("write"),
    grep: definition("grep"),
    find: definition("find"),
    ls: definition("ls"),
  };
  return nestedToolDefinitionsFixture(
    Object.hasOwn(impl, "powershell")
      ? { ...portable, powershell: definition("powershell") }
      : portable,
  );
};

const numericDefinitions = (calls: FakeCall[]): NestedPiToolDefinitions => {
  const implemented = (name: PiGuestToolName) => () => Promise.resolve(name);
  return fakeDefinitions(
    {
      read: implemented("read"),
      bash: implemented("bash"),
      powershell: implemented("powershell"),
      grep: implemented("grep"),
      find: implemented("find"),
      ls: implemented("ls"),
    },
    calls,
  );
};

interface HarnessOptions {
  readonly config?: Partial<CodeModeConfig>;
  readonly available?: boolean;
  readonly events?: ExtensionAPI["events"];
  readonly sessionId?: string | undefined;
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
    events: options.events ?? inertEvents,
    sessionId: options.sessionId === undefined ? "test-session" : options.sessionId,
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

  it.effect("rejects representative invalid numeric bounds before dispatch", () =>
    Effect.gen(function* () {
      const invalidNumericCalls = [
        `tools.pi.read({ path: "x", offset: 0 })`,
        `tools.pi.grep({ pattern: "x", context: -1 })`,
        `tools.pi.find({ pattern: "*", limit: Number.MAX_SAFE_INTEGER + 1 })`,
        `tools.pi.ls({ limit: Infinity })`,
        `tools.pi.bash({ command: "true", timeout: 0 })`,
        `tools.pi.powershell({ command: "Write-Output ok", timeout: NaN })`,
      ];
      const calls: FakeCall[] = [];
      const execute = makeHarness({
        config: { maxToolCalls: 100 },
        definitions: numericDefinitions(calls),
      });
      const attempts = invalidNumericCalls
        .map((call) => `[${JSON.stringify(call)}, () => ${call}]`)
        .join(",\n");
      const result = yield* Effect.promise(() =>
        execute(
          "call-invalid-numeric-inputs",
          {
            code: `
              const rejected = [];
              const attempts = [${attempts}];
              for (const [label, attempt] of attempts) {
                try {
                  await attempt();
                } catch {
                  rejected.push(label);
                }
              }
              return rejected;
            `,
          },
          undefined,
          undefined,
          ctx,
        ),
      );
      expect(guestJson(textOf(result))).toEqual(invalidNumericCalls);
      expect(calls).toEqual([]);
    }),
  );

  it.effect("forwards representative valid numeric inputs unchanged", () =>
    Effect.gen(function* () {
      const validNumericCalls = [
        {
          name: "read",
          source: `tools.pi.read({ path: "x", offset: 1, limit: Number.MAX_SAFE_INTEGER })`,
          input: { path: "x", offset: 1, limit: Number.MAX_SAFE_INTEGER },
        },
        {
          name: "grep",
          source: `tools.pi.grep({ pattern: "x", context: 0, limit: 7 })`,
          input: { pattern: "x", context: 0, limit: 7 },
        },
        {
          name: "bash",
          source: `tools.pi.bash({ command: "true", timeout: 0.5 })`,
          input: { command: "true", timeout: 0.5 },
        },
        {
          name: "powershell",
          source: `tools.pi.powershell({ command: "Write-Output ok", timeout: 0.25 })`,
          input: { command: "Write-Output ok", timeout: 0.25 },
        },
      ] as const;
      const calls: FakeCall[] = [];
      const execute = makeHarness({ definitions: numericDefinitions(calls) });
      const body = validNumericCalls
        .map(({ source }) => `values.push(await ${source});`)
        .join("\n");
      const result = yield* Effect.promise(() =>
        execute(
          "call-valid-numeric-inputs",
          {
            code: `
              const values = [];
              ${body}
              return values;
            `,
          },
          undefined,
          undefined,
          ctx,
        ),
      );
      expect(guestJson(textOf(result))).toEqual(validNumericCalls.map(({ name }) => name));
      expect(calls.map(({ name, input }) => ({ name, input }))).toEqual(
        validNumericCalls.map(({ name, input }) => ({ name, input })),
      );
    }),
  );

  it.effect("dispatches all seven core leaves through fake definitions", () =>
    Effect.gen(function* () {
      const implemented = (name: PiGuestToolName) => () => Promise.resolve(name);
      const definitions = fakeDefinitions({
        read: implemented("read"),
        bash: implemented("bash"),
        edit: implemented("edit"),
        write: implemented("write"),
        grep: implemented("grep"),
        find: implemented("find"),
        ls: implemented("ls"),
      });
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
    }),
  );

  it.effect("exposes PowerShell only when the current definitions include it", () =>
    Effect.gen(function* () {
      const calls: FakeCall[] = [];
      const windows = makeHarness({
        definitions: fakeDefinitions({ powershell: () => Promise.resolve("powershell-ok") }, calls),
      });
      const result = yield* Effect.promise(() =>
        windows(
          "call-powershell",
          { code: `return await tools.pi.powershell({ command: "Write-Output ok" });` },
          undefined,
          undefined,
          ctx,
        ),
      );
      expect(textOf(result)).toBe("powershell-ok");
      expect(calls.map((call) => call.name)).toEqual(["powershell"]);

      const nonWindows = makeHarness();
      yield* Effect.promise(() =>
        expect(
          nonWindows(
            "call-no-powershell",
            { code: `return await tools.pi.powershell({ command: "Write-Output nope" });` },
            undefined,
            undefined,
            ctx,
          ),
        ).rejects.toThrow(/Unknown tool.*pi\.powershell/s),
      );
    }),
  );

  it.effect("returns structured results from the explicit Background Tasks adapter", () =>
    Effect.gen(function* () {
      const calls: Array<{ id: string; input: unknown; signal: AbortSignal }> = [];
      const capability: BackgroundTaskCodeModeCapability = {
        version: BACKGROUND_TASK_CODE_MODE_VERSION,
        sessionId: "test-session",
        execute: (id, input, signal) => {
          calls.push({ id, input, signal });
          return Promise.resolve({
            action: "start",
            text: "Started bg-1",
            snapshot: backgroundSnapshot,
          });
        },
      };
      const execute = makeHarness({ events: backgroundEvents([capability]) });
      const result = yield* Effect.promise(() =>
        execute(
          "call-background",
          {
            code: `
              const started = await tools.session.backgroundTask({
                action: "start",
                command: "dev-server",
                name: "dev"
              });
              return { id: started.snapshot.id, state: started.snapshot.state };
            `,
          },
          undefined,
          undefined,
          ctx,
        ),
      );
      expect(guestJson(textOf(result))).toEqual({ id: "bg-1", state: "running" });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.id).toEqual(expect.stringMatching(/\S/));
      expect(calls[0]?.input).toMatchObject({ action: "start", command: "dev-server" });
      expect(calls[0]?.signal.aborted).toBe(false);
      expect(result.details.toolCalls[0]).toMatchObject({
        tool: "session.backgroundTask",
        status: "completed",
      });
    }),
  );

  it.effect("validates Background Tasks input before protocol discovery", () =>
    Effect.gen(function* () {
      let emissions = 0;
      const events = createEventBus();
      events.on(BACKGROUND_TASK_CODE_MODE_QUERY, () => {
        emissions += 1;
      });
      const execute = makeHarness({ events });
      yield* Effect.promise(() =>
        expect(
          execute(
            "call-invalid-background",
            { code: `return await tools.session.backgroundTask({ action: "invalid" });` },
            undefined,
            undefined,
            ctx,
          ),
        ).rejects.toThrow(/InvalidToolInput/),
      );
      expect(emissions).toBe(0);
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
  it.effect("charges structured Background Tasks output as compact JSON", () =>
    Effect.gen(function* () {
      const capability: BackgroundTaskCodeModeCapability = {
        version: BACKGROUND_TASK_CODE_MODE_VERSION,
        sessionId: "test-session",
        execute: () =>
          Promise.resolve({
            action: "status",
            text: "x".repeat(200),
            snapshot: backgroundSnapshot,
          }),
      };
      const result = yield* Effect.promise(() =>
        makeHarness({
          events: backgroundEvents([capability]),
          config: { maxCumulativeChildOutputBytes: 80 },
        })(
          "call-background-budget",
          {
            code: `
              try {
                await tools.session.backgroundTask({ action: "status", id: "bg-1" });
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
      // SAFETY: The guest program above constructs this exact JSON object.
      const observed = guestJson(textOf(result)) as { message: string; length: number };
      expect(observed.message).toContain("returned output beyond");
      expect(observed.length).toBeLessThanOrEqual(80);
    }),
  );

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
  it.effect("aborts a nested Background Tasks wait through the protocol signal", () =>
    Effect.gen(function* () {
      const started = Deferred.makeUnsafe<void>();
      let seenSignal: AbortSignal | undefined;
      const capability: BackgroundTaskCodeModeCapability = {
        version: BACKGROUND_TASK_CODE_MODE_VERSION,
        sessionId: "test-session",
        execute: (_id, _input, signal) => {
          seenSignal = signal;
          void Deferred.doneUnsafe(started, Effect.void);
          return blockingCall();
        },
      };
      const execute = makeHarness({ events: backgroundEvents([capability]) });
      const controller = new AbortController();
      const pending = execute(
        "call-background-abort",
        {
          code: `return await tools.session.backgroundTask({ action: "wait", id: "bg-1", until: "exit" });`,
        },
        controller.signal,
        undefined,
        ctx,
      );
      yield* Deferred.await(started);
      controller.abort();
      const result = yield* Effect.promise(() => pending);
      expect(textOf(result)).toBe("Execution cancelled.");
      expect(seenSignal?.aborted).toBe(true);
    }),
  );

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

  it.effect("retains recent failures and cancellations beyond the 256-row cap", () =>
    Effect.gen(function* () {
      const callCount = 300;
      const executeCodeMode: NonNullable<CodeModeExecutionEnvironment["executeCodeMode"]> = (
        options,
      ) =>
        Effect.gen(function* () {
          for (let id = 0; id < callCount; id += 1) {
            const name = `nested-${id}`;
            yield* options.onToolCallLifecycle?.({ id, name, status: "queued" }) ?? Effect.void;
            if (id % 2 === 0) {
              yield* (
                options.onToolCallLifecycle?.({
                  id,
                  name,
                  status: "running",
                }) ?? Effect.void
              );
              yield* (
                options.onToolCallLifecycle?.({
                  id,
                  name,
                  status: "failed",
                  started: true,
                  durationMs: 1,
                }) ?? Effect.void
              );
            } else {
              yield* (
                options.onToolCallLifecycle?.({
                  id,
                  name,
                  status: "cancelled",
                  started: false,
                  durationMs: 1,
                }) ?? Effect.void
              );
            }
          }
          return { ok: true as const, value: "done" };
        });
      const execute = makeHarness({
        config: { maxToolCalls: callCount },
        executeCodeMode,
      });
      const result = yield* Effect.promise(() =>
        execute("call-settled-retention", { code: "return 'done';" }, undefined, undefined, ctx),
      );

      expect(result.details.counts).toEqual({
        total: callCount,
        queued: 0,
        running: 0,
        succeeded: 0,
        failed: callCount / 2,
        cancelled: callCount / 2,
      });
      expect(result.details.toolCalls.map(({ tool }) => tool)).toEqual(
        Array.from(
          { length: MAX_PROGRESS_ENTRIES },
          (_, offset) => `nested-${callCount - MAX_PROGRESS_ENTRIES + offset}`,
        ),
      );
      expect(result.details.toolCalls.map(({ status }) => status)).toEqual(
        Array.from({ length: MAX_PROGRESS_ENTRIES }, (_, offset) =>
          (callCount - MAX_PROGRESS_ENTRIES + offset) % 2 === 0 ? "error" : "cancelled",
        ),
      );
    }),
  );

  it.effect("never evicts queued or running rows at the 256-row cap", () =>
    Effect.gen(function* () {
      const succeeded = 300;
      const executeCodeMode: NonNullable<CodeModeExecutionEnvironment["executeCodeMode"]> = (
        options,
      ) =>
        Effect.gen(function* () {
          yield* (
            options.onToolCallLifecycle?.({
              id: 0,
              name: "queued-survivor",
              status: "queued",
            }) ?? Effect.void
          );
          yield* (
            options.onToolCallLifecycle?.({
              id: 1,
              name: "running-survivor",
              status: "queued",
            }) ?? Effect.void
          );
          yield* (
            options.onToolCallLifecycle?.({
              id: 1,
              name: "running-survivor",
              status: "running",
            }) ?? Effect.void
          );
          for (let offset = 0; offset < succeeded; offset += 1) {
            const id = offset + 2;
            const name = `completed-${id}`;
            yield* options.onToolCallLifecycle?.({ id, name, status: "queued" }) ?? Effect.void;
            yield* (
              options.onToolCallLifecycle?.({
                id,
                name,
                status: "running",
              }) ?? Effect.void
            );
            yield* (
              options.onToolCallLifecycle?.({
                id,
                name,
                status: "succeeded",
                started: true,
                durationMs: 1,
              }) ?? Effect.void
            );
          }
          return { ok: true as const, value: "done" };
        });
      const execute = makeHarness({
        config: { maxToolCalls: succeeded + 2 },
        executeCodeMode,
      });
      const result = yield* Effect.promise(() =>
        execute("call-active-retention", { code: "return 'done';" }, undefined, undefined, ctx),
      );

      expect(result.details.counts).toEqual({
        total: succeeded + 2,
        queued: 0,
        running: 0,
        succeeded,
        failed: 0,
        cancelled: 2,
      });
      expect(result.details.toolCalls.slice(0, 2)).toEqual([
        expect.objectContaining({ tool: "queued-survivor", status: "cancelled" }),
        expect.objectContaining({ tool: "running-survivor", status: "cancelled" }),
      ]);
      expect(result.details.toolCalls.at(-1)?.tool).toBe(`completed-${succeeded + 1}`);
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
      expect(updates[0]?.text.trim().length).toBeGreaterThan(0);
      expect(updates[0]?.details.toolCalls).toEqual([]);
      const callUpdates = updates.slice(1);
      for (const update of callUpdates) {
        expect(update.text).not.toContain(secret);
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
            activity: expect.stringMatching(/\S/),
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
