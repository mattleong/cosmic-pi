// End-to-end `code_mode` execution through the real vendored runtime over fake Pi definitions:
// exact guest catalog, host limits, cancellation, progress, and diagnostics.
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import { BACKGROUND_TASK_CODE_MODE_QUERY } from "pi-background-task/code-mode";
import { McpCodeModeOutputSchema, mcpCodeModeError } from "pi-mcp/code-mode";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ToolCallLifecycleEvent } from "../src/engine/dispatch.ts";
import { executeProgram } from "../src/engine/execute.ts";
import {
  type NestedPiToolDefinitions,
  type PiGuestToolInput,
  type PiGuestToolName,
} from "../src/boundary/host-builtin-tools.ts";
import {
  CODE_MODE_UNAVAILABLE_MESSAGE,
  type CodeModeExecutionEnvironment,
} from "../src/tools/execution.ts";
import {
  formatCodeModeSuccess,
  MAX_PROGRESS_ENTRIES,
  type CodeModeToolDetails,
} from "../src/tools/format.ts";
import { checkSourceSize, clampModelVisibleText, utf8ByteLength } from "../src/tools/limits.ts";
import {
  executeHarness,
  textOf,
  type CallOptions,
  type ExecuteHarnessOptions,
} from "./support/execute.ts";
import { codeModeStateFixture } from "./support/host.ts";
import { backgroundTaskProvider, mcpProvider } from "./support/providers.ts";
import { nestedToolDefinitionsFixture } from "./support/tools.ts";

// JSON here decodes guest results; these are code fixtures under test control.
const guestJson = (text: string) => JSON.parse(text);

/** A foreign nested call that remains pending until Effect interrupts its owning adapter. */
const blockingCall = (onStart?: () => void): Promise<never> => {
  onStart?.();
  return Promise.race([]);
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

const leafDefinitions = (calls: FakeCall[]): NestedPiToolDefinitions => {
  const implemented = (name: PiGuestToolName) => () => Promise.resolve(name);
  return fakeDefinitions(
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
};

interface HarnessOptions extends ExecuteHarnessOptions {
  readonly available?: boolean;
  /** Simulates the no-current-state gate: getState() returns undefined. */
  readonly noState?: boolean;
}

type LifecycleEmit = (event: ToolCallLifecycleEvent) => Effect.Effect<void>;
/** Execution stand-in that emits scripted lifecycle events, then returns successfully. */
const scriptedRuntime =
  (
    script: (emit: LifecycleEmit) => Effect.Effect<void>,
  ): NonNullable<CodeModeExecutionEnvironment["executeCodeMode"]> =>
  (options) =>
    script((event) => options.onToolCallLifecycle?.(event) ?? Effect.void).pipe(
      Effect.as({ ok: true as const, value: "done" }),
    );

/** The suite's positional call form over the shared harness, with fake Pi definitions. */
const makeHarness = ({ available = true, noState = false, ...options }: HarnessOptions = {}) => {
  const state = codeModeStateFixture(options.config, { available });
  const harness = executeHarness({
    cwd: "/",
    definitions: fakeDefinitions({}),
    getState: () => (noState ? undefined : state),
    ...options,
  });
  return Object.assign(
    (id: string, code: string, signal?: AbortSignal, onUpdate?: CallOptions["onUpdate"]) =>
      harness.run(code, { id, signal, onUpdate }),
    { guestValue: harness.guestValue },
  );
};

describe("guest catalog", () => {
  it.effect("rejects representative invalid input before dispatch", () =>
    Effect.gen(function* () {
      const invalidCalls = [
        `tools.pi.read({ path: "x", offset: 0 })`,
        `tools.pi.grep({ pattern: "x", context: -1 })`,
        `tools.pi.find({ pattern: "*", limit: Number.MAX_SAFE_INTEGER + 1 })`,
        `tools.pi.ls({ limit: Infinity })`,
        `tools.pi.bash({ command: "true", timeout: 0 })`,
        `tools.pi.edit({ path: "x", edits: [] })`,
      ];
      const calls: FakeCall[] = [];
      const execute = makeHarness({
        config: { maxToolCalls: 100 },
        definitions: leafDefinitions(calls),
      });
      const attempts = invalidCalls
        .map((call) => `[${JSON.stringify(call)}, () => ${call}]`)
        .join(",\n");
      const result = yield* Effect.promise(() =>
        execute(
          "call-invalid-numeric-inputs",
          `
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
        ),
      );
      expect(guestJson(textOf(result))).toEqual(invalidCalls);
      expect(calls).toEqual([]);
    }),
  );

  it.effect("forwards representative valid input to every leaf unchanged", () =>
    Effect.gen(function* () {
      const validCalls = [
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
          name: "edit",
          source: `tools.pi.edit({ path: "a", edits: [{ oldText: "before", newText: "after" }] })`,
          input: { path: "a", edits: [{ oldText: "before", newText: "after" }] },
        },
        {
          name: "write",
          source: `tools.pi.write({ path: "a", content: "x" })`,
          input: { path: "a", content: "x" },
        },
        { name: "find", source: `tools.pi.find({ pattern: "*" })`, input: { pattern: "*" } },
        { name: "ls", source: `tools.pi.ls({})`, input: {} },
      ] as const;
      const calls: FakeCall[] = [];
      const execute = makeHarness({ definitions: leafDefinitions(calls) });
      const body = validCalls.map(({ source }) => `values.push(await ${source});`).join("\n");
      const result = yield* Effect.promise(() =>
        execute(
          "call-valid-numeric-inputs",
          `
              const values = [];
              ${body}
              return values;
            `,
        ),
      );
      expect(guestJson(textOf(result))).toEqual(validCalls.map(({ name }) => name));
      expect(calls.map(({ name, input }) => ({ name, input }))).toEqual(
        validCalls.map(({ name, input }) => ({ name, input })),
      );
    }),
  );

  it.effect("returns structured results from the explicit Background Tasks adapter", () =>
    Effect.gen(function* () {
      const calls: Array<{ id: string; input: unknown; signal: AbortSignal }> = [];
      const events = backgroundTaskProvider((id, input, signal) => {
        calls.push({ id, input, signal });
        return Promise.resolve({
          action: "start",
          text: "Started bg-1",
          snapshot: backgroundSnapshot,
        });
      });
      const execute = makeHarness({ events });
      const result = yield* Effect.promise(() =>
        execute(
          "call-background",
          `
              const started = await tools.session.backgroundTask({
                action: "start",
                command: "dev-server",
                name: "dev"
              });
              return { id: started.snapshot.id, state: started.snapshot.state };
            `,
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
            `return await tools.session.backgroundTask({ action: "invalid" });`,
          ),
        ).rejects.toThrow(/InvalidToolInput/),
      );
      expect(emissions).toBe(0);
    }),
  );
});

describe("early-path clamp wiring", () => {
  it.effect("clamps or fixes every early outcome before program work", () =>
    Effect.gen(function* () {
      const code = "return 1;";
      const source = "éé";
      const failure = "🔥".repeat(100);
      interface Case {
        readonly name: string;
        readonly options: HarnessOptions;
        readonly expected?: string;
        readonly source?: string;
        readonly returned?: boolean;
        readonly abort?: boolean;
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
          executeCodeMode: (runtimeOptions) =>
            Effect.suspend(() => {
              runtimeCalls += 1;
              return executeProgram(runtimeOptions);
            }),
        });
        const controller = new AbortController();
        if (testCase.abort === true) controller.abort();
        const settled = yield* Effect.promise(() =>
          execute(`call-${name}`, testCase.source ?? code, controller.signal).then(
            (result) => ({ _tag: "returned" as const, result }),
            (error) => ({
              _tag: "thrown" as const,
              message: error instanceof Error ? error.message : String(error),
            }),
          ),
        );
        expect(settled._tag, name).toBe(testCase.returned === true ? "returned" : "thrown");
        const text = settled._tag === "returned" ? textOf(settled.result) : settled.message;
        if (expected !== undefined) expect(text, name).toBe(expected);
        else
          expect(utf8ByteLength(text), name).toBeLessThanOrEqual(options.config!.maxOutputBytes!);
        expect(text, name).not.toContain("�");
        expect(runtimeCalls, name).toBe(0);
        if (settled._tag === "returned") expect(settled.result.details.cancelled).toBe(true);
      }
    }),
  );
});

describe("host limits", () => {
  it.effect("enforces maxToolCalls before dispatching an excess nested call", () =>
    Effect.gen(function* () {
      const calls: FakeCall[] = [];
      const execute = makeHarness({
        config: { maxToolCalls: 4 },
        definitions: fakeDefinitions({ read: () => Promise.resolve("ok") }, calls),
      });
      yield* Effect.promise(() =>
        expect(
          execute(
            "call-limits",
            `
                for (let index = 0; index < 5; index += 1) {
                  await tools.pi.read({ path: String(index) });
                }
              `,
          ),
        ).rejects.toThrow(/\[ToolCallLimitExceeded\]/),
      );
      expect(calls.map((call) => call.input)).toEqual([
        { path: "0" },
        { path: "1" },
        { path: "2" },
        { path: "3" },
      ]);
    }),
  );

  it.effect("applies timeoutMs as the program deadline and aborts in-flight nested calls", () =>
    Effect.gen(function* () {
      const calls: FakeCall[] = [];
      const definitions = fakeDefinitions({ read: () => blockingCall() }, calls);
      const execute = makeHarness({ config: { timeoutMs: 2_000 }, definitions });
      yield* Effect.promise(() =>
        expect(
          execute("call-timeout", "return await tools.pi.read({ path: 'hang' });"),
        ).rejects.toThrow(/\[TimeoutExceeded\].*2000ms/s),
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]?.signal?.aborted).toBe(true);
    }),
  );
});

describe("final model-visible byte bound", () => {
  it.effect("clamps structured success with logs while preserving its output kind", () =>
    Effect.gen(function* () {
      const sample = {
        ok: true,
        value: { items: [1, 2], label: "café" },
        logs: ["tail"],
      } as const;
      for (const budget of [20, 1000]) {
        const execute = makeHarness({
          config: { maxOutputBytes: budget },
          executeCodeMode: () => Effect.succeed(sample),
        });
        const result = yield* Effect.tryPromise(() =>
          execute("call-structured-bound", "return null;"),
        );
        expect(utf8ByteLength(textOf(result))).toBeLessThanOrEqual(budget);
        if (budget >= utf8ByteLength(formatCodeModeSuccess(sample))) {
          expect(textOf(result)).toBe(formatCodeModeSuccess(sample));
        } else {
          expect(result.details.truncated).toBe(true);
          expect(textOf(result)).toContain("Full output");
        }
        expect(result.details.outputKind).toBe("structured");
      }
    }),
  );

  it.effect("bounds success logs and diagnostic framing", () =>
    Effect.gen(function* () {
      for (const [budget, code, expected] of [
        [
          48,
          "console.log('a log line that is fairly long'); return 'result value here';",
          "returned",
        ],
        [40, "const x = ;\nreturn 1;", "thrown"],
      ] as const) {
        const settled = yield* Effect.promise(() =>
          makeHarness({ config: { maxOutputBytes: budget } })("call-final-bound", code).then(
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
      const execute = makeHarness({
        events: backgroundTaskProvider(() =>
          Promise.resolve({
            action: "status",
            text: "x".repeat(200),
            snapshot: backgroundSnapshot,
          }),
        ),
        config: { maxCumulativeChildOutputBytes: 80 },
      });
      const result = yield* Effect.promise(() =>
        execute(
          "call-background-budget",
          `
              try {
                await tools.session.backgroundTask({ action: "status", id: "bg-1" });
                return "unexpected";
              } catch (error) {
                return { message: error.message, length: error.message.length };
              }
            `,
        ),
      );
      // SAFETY: The guest program above constructs this exact JSON object.
      const observed = execute.guestValue() as { message: string; length: number };
      expect(textOf(result)).toContain("Do not replay");
      expect(observed.message).toContain("returned output beyond");
      expect(observed.length).toBeLessThanOrEqual(80);
    }),
  );

  it.effect("charges repeated output-overrun refusals through a real program", () =>
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
        const execute = makeHarness({
          config: { maxCumulativeChildOutputBytes: limit },
          definitions,
        });
        const result = yield* Effect.promise(() => execute(`call-budget-${limit}`, code));
        expect(execute.guestValue()).toEqual(expected);
        expect(textOf(result)).toContain("Do not replay");
      }
    }),
  );
});

describe("cancellation", () => {
  type OnStart = (signal: AbortSignal | undefined) => void;
  it.effect.each([
    {
      label: "Pi read",
      code: "return await tools.pi.read({ path: 'hang' });",
      subject: "hang",
      options: (onStart: OnStart): HarnessOptions => ({
        definitions: fakeDefinitions({
          read: (_input, signal) => blockingCall(() => onStart(signal)),
        }),
      }),
    },
    {
      label: "Background Tasks wait",
      code: `return await tools.session.backgroundTask({ action: "wait", id: "bg-1", until: "exit" });`,
      options: (onStart: OnStart): HarnessOptions => ({
        events: backgroundTaskProvider((_id, _input, signal) =>
          blockingCall(() => onStart(signal)),
        ),
      }),
    },
    {
      label: "MCP call",
      code: `return await tools.mcp.request({action:"tools.call",server:"fixture",tool:"wait"});`,
      options: (onStart: OnStart): HarnessOptions => ({
        events: mcpProvider((_id, _input, signal) => blockingCall(() => onStart(signal))),
      }),
    },
  ])(
    "aborts a pending $label and its nested signal without waiting for foreign settlement",
    ({ code, subject, options }) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<AbortSignal | undefined>();
        const execute = makeHarness(
          options((signal) => Deferred.doneUnsafe(started, Effect.succeed(signal))),
        );
        const controller = new AbortController();
        const pending = execute("call-abort", code, controller.signal);
        const signal = yield* Deferred.await(started);
        controller.abort();
        const result = yield* Effect.promise(() => pending);
        expect(signal?.aborted).toBe(true);
        expect(textOf(result)).toContain("Execution cancelled.");
        expect(result.details.cancelled).toBe(true);
        expect(result.details.executionReceipts).toMatchObject({ total: 1, unknown: 1 });
        if (subject !== undefined) expect(result.details.toolCalls[0]?.subject).toBe(subject);
      }),
  );
});

describe("progress", () => {
  it.effect("captures distinct argument targets without retaining bodies or output", () =>
    Effect.gen(function* () {
      const definitions = fakeDefinitions({
        read: () => Promise.resolve("PRIVATE OUTPUT"),
        write: () => Promise.resolve("saved"),
      });
      const execute = makeHarness({ definitions });
      const result = yield* Effect.promise(() =>
        execute(
          "call-subjects",
          `
        await Promise.all([
          tools.pi.read({path:"first.ts", offset:2, limit:3}),
          tools.pi.read({path:"second.ts", limit:1})
        ]);
        await tools.pi.write({path:"new.ts", content:"PRIVATE BODY"});
        return "done";
      `,
          undefined,
          (partial) => {
            for (const call of partial.details.toolCalls)
              Reflect.set(call, "subject", "HOST MUTATION");
          },
        ),
      );
      expect(textOf(result)).toBe("done");
      expect(result.details.toolCalls.map((call) => call.subject)).toEqual([
        "first.ts:2-4",
        "second.ts:1-1",
        "new.ts",
      ]);
      expect(Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(result.details)).not.toMatch(
        /PRIVATE|HOST MUTATION/u,
      );
    }),
  );

  it.effect("keeps high-call cancellation final state isolated from hostile progress updates", () =>
    Effect.gen(function* () {
      const executeCodeMode = scriptedRuntime((emit) =>
        Effect.gen(function* () {
          for (let id = 0; id <= 256; id += 1)
            yield* emit({ id, name: "pi.read", status: "queued" });
          yield* emit({
            id: 256,
            name: "pi.read",
            status: "cancelled",
            started: false,
            durationMs: 1,
          });
        }),
      );
      const execute = makeHarness({ executeCodeMode });
      const result = yield* Effect.promise(() =>
        execute("call-never-started", "return 'done';", undefined, (partial) => {
          Reflect.set(partial.details.counts ?? {}, "total", -1);
          Reflect.set(partial.details.toolCalls[0] ?? {}, "tool", "hostile-update");
        }),
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
      expect(result.details.toolCalls[0]?.subject).toBeUndefined();
    }),
  );

  it.effect("retains recent failures and cancellations beyond the 256-row cap", () =>
    Effect.gen(function* () {
      const callCount = 300;
      const executeCodeMode = scriptedRuntime((emit) =>
        Effect.gen(function* () {
          for (let id = 0; id < callCount; id += 1) {
            const name = `nested-${id}`;
            yield* emit({ id, name, status: "queued" });
            if (id % 2 === 0) {
              yield* emit({ id, name, status: "running" });
              yield* emit({ id, name, status: "failed", started: true, durationMs: 1 });
            } else yield* emit({ id, name, status: "cancelled", started: false, durationMs: 1 });
          }
        }),
      );
      const execute = makeHarness({
        config: { maxToolCalls: callCount },
        executeCodeMode,
      });
      const result = yield* Effect.promise(() =>
        execute("call-settled-retention", "return 'done';"),
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
      const executeCodeMode = scriptedRuntime((emit) =>
        Effect.gen(function* () {
          yield* emit({ id: 0, name: "queued-survivor", status: "queued" });
          yield* emit({ id: 1, name: "running-survivor", status: "queued" });
          yield* emit({ id: 1, name: "running-survivor", status: "running" });
          for (let offset = 0; offset < succeeded; offset += 1) {
            const id = offset + 2;
            const name = `completed-${id}`;
            yield* emit({ id, name, status: "queued" });
            yield* emit({ id, name, status: "running" });
            yield* emit({ id, name, status: "succeeded", started: true, durationMs: 1 });
          }
        }),
      );
      const execute = makeHarness({
        config: { maxToolCalls: succeeded + 2 },
        executeCodeMode,
      });
      const result = yield* Effect.promise(() =>
        execute("call-active-retention", "return 'done';"),
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
          "return await tools.pi.read({ path: 'a' });",
          undefined,
          (partial) => {
            updates.push({ text: textOf(partial), details: partial.details });
          },
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
          `
          try {
            await tools.pi.bash({ command: "false" });
            return "unexpected";
          } catch (error) {
            return { message: error.message, length: error.message.length };
          }
        `,
        ),
      );
      // SAFETY: The test controls the serialized fixture and asserts the exact decoded contract below.
      const observed = execute.guestValue() as { message: string; length: number };
      expect(textOf(result)).toContain("Do not replay");
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
          execute("call-retained-failure", `return await tools.pi.read({ path: "missing" });`),
        ).rejects.toThrow(/ToolFailure/),
      );
      expect(retained).toHaveLength(1);
      expect(retained[0]?.id).toBe("call-retained-failure");
      expect(retained[0]?.details.toolCalls[0]?.status).toBe("error");
      expect(retained[0]?.details.toolCalls[0]?.subject).toBe("missing");
      expect(retained[0]?.details.counts).toMatchObject({ total: 1, failed: 1 });
    }),
  );
});

describe("MCP guest execution", () => {
  it.effect("batches calls concurrently and reads retained results in the same program", () =>
    Effect.gen(function* () {
      const started: string[] = [];
      const ids = new Set<string>();
      const release = yield* Deferred.make<void>();
      const events = mcpProvider((callId, input, _signal, allowance) => {
        ids.add(callId);
        expect(allowance).toBeGreaterThan(0);
        if (input.action === "tools.call") {
          started.push(input.tool);
          if (started.length === 2) Effect.runSync(Deferred.succeed(release, undefined));
          return Effect.runPromise(Deferred.await(release)).then(() => ({
            action: input.action,
            outcome: "completed" as const,
            isError: input.tool === "second",
            data: null,
            resultId: input.tool,
            notices: ["retained"],
          }));
        }
        if (input.action === "result.read")
          return Promise.resolve({
            action: input.action,
            outcome: "completed" as const,
            isError: false,
            data: { originalIsError: input.id === "second", text: input.id },
            notices: [],
          });
        throw new Error("unexpected request");
      });
      const result = yield* Effect.promise(() =>
        makeHarness({ events })(
          "mcp-batch",
          `
      const replies = await Promise.all(["first", "second"].map(tool => tools.mcp.request({ action: "tools.call", server: "fixture", tool })));
      return await Promise.all(replies.map(reply => tools.mcp.request({ action: "result.read", id: reply.resultId })));
    `,
        ),
      );
      expect(started).toEqual(["first", "second"]);
      expect(ids.size).toBe(4);
      expect(guestJson(textOf(result)).map((reply: { data: object }) => reply.data)).toEqual([
        { originalIsError: false, text: "first" },
        { originalIsError: true, text: "second" },
      ]);
      expect(result.details.counts).toMatchObject({ total: 4, succeeded: 4 });
    }),
  );

  it.effect("rejects management and excess fields before the provider receives anything", () =>
    Effect.gen(function* () {
      let called = false;
      const events = mcpProvider(() => {
        called = true;
        return Promise.reject(new Error("unreachable"));
      });
      const result = yield* Effect.promise(() =>
        makeHarness({ events })(
          "mcp-closed",
          `
      const rejected = [];
      for (const input of [{action:"disconnect",server:"fixture"},{action:"refresh",server:"fixture"},{action:"auth"},{action:"status",connect:true},{action:"config.write"}]) {
        try { await tools.mcp.request(input); } catch { rejected.push(input.action); }
      }
      return rejected;
    `,
        ),
      );
      expect(guestJson(textOf(result))).toEqual([
        "disconnect",
        "refresh",
        "auth",
        "status",
        "config.write",
      ]);
      expect(called).toBe(false);
    }),
  );

  it.effect("keeps built-ins usable without either companion and makes MCP absence catchable", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        makeHarness({ definitions: fakeDefinitions({ read: () => Promise.resolve("file") }) })(
          "mcp-absent",
          `
      let absent = false;
      try { await tools.mcp.request({action:"status"}); } catch { absent = true; }
      return { absent, text: await tools.pi.read({path:"fixture"}) };
    `,
        ),
      );
      expect(guestJson(textOf(result))).toEqual({ absent: true, text: "file" });
    }),
  );

  it.effect(
    "charges compact JSON successes and catchable failure text to one cumulative budget",
    () =>
      Effect.gen(function* () {
        const allowances: number[] = [];
        const response = {
          action: "status",
          outcome: "completed" as const,
          isError: false,
          data: null,
          notices: [],
        };
        const events = mcpProvider((_id, _input, _signal, allowance) => {
          allowances.push(allowance);
          if (allowances.length === 1) return Promise.resolve(response);
          return Promise.reject(mcpCodeModeError("transport", "unknown"));
        });
        const execute = makeHarness({ events, config: { maxCumulativeChildOutputBytes: 400 } });
        const result = yield* Effect.promise(() =>
          execute(
            "mcp-budget",
            `
      await tools.mcp.request({action:"status"});
      const errors = [];
      for (let i=0;i<4;i++) { try { await tools.mcp.request({action:"status"}); } catch (error) { errors.push(error.message); } }
      return errors;
    `,
          ),
        );
        const serialized = yield* Schema.encodeEffect(
          Schema.fromJsonString(McpCodeModeOutputSchema),
        )(response);
        expect(allowances[1]).toBe(400 - utf8ByteLength(serialized));
        // SAFETY: The controlled guest program returns only caught error.message strings.
        const errors = execute.guestValue() as string[];
        expect(textOf(result)).toContain("Do not replay");
        expect(errors.reduce((sum, message) => sum + utf8ByteLength(message), 0)).toBe(
          allowances[1],
        );
        expect(allowances.at(-1)).toBe(0);
        expect(errors.at(-1)).toBe("");
      }),
  );
});
