import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as JsonSchema from "effect/JsonSchema";
import * as SchemaRepresentation from "effect/SchemaRepresentation";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  applyPresentationSettings,
  captureRegistrations,
  issueMessageStyleProblems,
} from "pi-code-previews/testing";
import { extensionContextFixture } from "pi-cosmic-core/testing";
import { afterEach } from "vitest";
import { projectBackgroundTaskCodeModeOutput } from "../src/code-mode/output.ts";
import { backgroundTaskNotFound } from "../src/task/errors.ts";
import type { BackgroundLogEvent, BackgroundTaskStatus } from "../src/task/model.ts";
import { BackgroundTaskService, type BackgroundTaskServiceContract } from "../src/task/service.ts";
import { utf8ByteLength } from "../src/task/utf8.ts";
import { registerBackgroundTaskTool } from "../src/tools/background-task.ts";
import { executeBackgroundTaskCommand } from "../src/tools/command.ts";
import {
  BackgroundTaskContractSchema,
  MAX_CONTRACT_LOG_OUTPUT_BYTES,
  encodeBackgroundTaskContract,
  type BackgroundTaskContract,
} from "../src/tools/contract-schema.ts";
import type { BackgroundTaskToolInput } from "../src/tools/schema.ts";

const restoreSettings = applyPresentationSettings({});
afterEach(restoreSettings);

const unexpected = () => Effect.die("unexpected background task service call");
const baseService: BackgroundTaskServiceContract = {
  start: unexpected,
  list: unexpected,
  status: unexpected,
  logs: unexpected,
  wait: unexpected,
  stop: unexpected,
  stopAll: unexpected,
  clear: unexpected(),
};
type ServiceOverrides = Partial<BackgroundTaskServiceContract>;

// Command, cwd, and pid carry markers that must never reach a contract.
const task = (overrides: Partial<BackgroundTaskStatus> = {}): BackgroundTaskStatus => ({
  id: "task-1",
  name: "dev server",
  command: "command-marker pnpm dev",
  cwd: "/cwd-marker",
  state: "running",
  pid: 987_654,
  startedAt: 100,
  logCursor: 3,
  droppedLogBytes: 0,
  ...overrides,
});
const event = (
  cursor: number,
  text: string,
  stream: BackgroundLogEvent["stream"] = "stdout",
): BackgroundLogEvent => ({ cursor, stream, text, timestamp: cursor, bytes: utf8ByteLength(text) });

const execute = (input: BackgroundTaskToolInput, overrides: ServiceOverrides) =>
  executeBackgroundTaskCommand(input, "/project").pipe(
    Effect.provideService(BackgroundTaskService, { ...baseService, ...overrides }),
    Effect.provide(Path.layer),
  );

const serialize = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeStrict = Schema.decodeUnknownSync(Schema.toCodecJson(BackgroundTaskContractSchema), {
  onExcessProperty: "error",
});

/** The strict JSON encoding, which must decode back to the producer's contract unchanged. */
const encoded = (contract: BackgroundTaskContract) => {
  const json = encodeBackgroundTaskContract(contract);
  expect(json).toBeDefined();
  expect(decodeStrict(json)).toEqual(contract);
  return json;
};

const registeredTool = (overrides: ServiceOverrides) => {
  const service = { ...baseService, ...overrides };
  return captureRegistrations((pi) =>
    registerBackgroundTaskTool(pi, {
      run: <A, E>(effect: Effect.Effect<A, E, BackgroundTaskService | Path.Path>) =>
        Effect.runPromise(
          effect.pipe(
            Effect.provideService(BackgroundTaskService, service),
            Effect.provide(Path.layer),
          ),
        ),
    }),
  ).tools[0]!;
};
const ctx = extensionContextFixture({ cwd: "/project" });

describe("background_task contract", () => {
  it.effect("projects every successful action from domain facts into one strict contract", () =>
    Effect.gen(function* () {
      const failed = task({ id: "task-2", state: "failed", endedAt: 200, exitCode: 1 });
      const services: ServiceOverrides = {
        start: () => Effect.succeed(task({ state: "starting" })),
        status: () => Effect.succeed(task()),
        stop: () => Effect.succeed(task({ state: "stopped", endedAt: 300, signal: "SIGTERM" })),
        list: () => Effect.succeed([task(), failed]),
        stopAll: () => Effect.succeed([task({ state: "stopped", endedAt: 300, exitCode: null })]),
        logs: () =>
          Effect.succeed({
            id: "task-1",
            state: "running",
            nextCursor: 4,
            earliestAvailableCursor: 2,
            droppedBytes: 0,
            events: [event(2, "ready\n")],
          }),
        wait: () =>
          Effect.succeed({
            id: "task-1",
            outcome: "matched",
            snapshot: task(),
            nextCursor: 4,
            earliestAvailableCursor: 2,
            droppedBytes: 0,
            matchCursor: 2,
          }),
        clear: Effect.succeed(2),
      };
      const inputs: ReadonlyArray<BackgroundTaskToolInput> = [
        { action: "start", command: "pnpm dev", name: "dev server" },
        { action: "status", id: "task-1" },
        { action: "stop", id: "task-1" },
        { action: "list" },
        { action: "stop_all" },
        { action: "logs", id: "task-1" },
        { action: "wait", id: "task-1", until: "output", contains: "ready" },
        { action: "clear" },
      ];
      for (const input of inputs) {
        const { contract } = yield* execute(input, services);
        const json = encoded(contract);
        expect(contract).toMatchObject({
          contract: "pi-background-task/task",
          version: 1,
          tool: "background_task",
          action: input.action,
        });
        const serialized = serialize(json);
        for (const leaked of ["command-marker", "cwd-marker", "987654", '"pid"', '"awaited"'])
          expect(serialized).not.toContain(leaked);
      }
      const list = (yield* execute({ action: "list" }, services)).contract;
      expect(list.action === "list" && list.tasks.map((entry) => entry.id)).toEqual([
        "task-1",
        "task-2",
      ]);
      const wait = (yield* execute(inputs[6]!, services)).contract;
      expect(wait).toMatchObject({ outcome: "matched", matchCursor: 2, task: { id: "task-1" } });
      expect((yield* execute({ action: "clear" }, services)).contract).toMatchObject({
        removed: 2,
      });
    }),
  );

  it.effect("reports finished as terminal task state, never as success or cleanup proof", () =>
    Effect.gen(function* () {
      const tasks = [
        task({ id: "running" }),
        task({ id: "stopping", state: "stopping" }),
        task({ id: "exited", state: "exited", endedAt: 2, exitCode: 0 }),
        task({ id: "failed", state: "failed", endedAt: 2, exitCode: 1 }),
        task({ id: "spawn", state: "failed", endedAt: 2, error: "Couldn't start the process" }),
        task({ id: "stopped", state: "stopped", endedAt: 2, exitCode: null, signal: "SIGTERM" }),
        task({ id: "timed_out", state: "timed_out", endedAt: 2 }),
      ];
      const { contract } = yield* execute(
        { action: "list" },
        { list: () => Effect.succeed(tasks) },
      );
      if (contract.action !== "list") throw new Error("list returned the wrong contract");
      encoded(contract);
      expect(contract.tasks.map(({ id, finished }) => [id, finished])).toEqual([
        ["running", false],
        ["stopping", false],
        ["exited", true],
        ["failed", true],
        ["spawn", true],
        ["stopped", true],
        ["timed_out", true],
      ]);
      // Finished failures keep the evidence that distinguishes them from success.
      expect(contract.tasks[3]).toMatchObject({ state: "failed", finished: true, exitCode: 1 });
      expect(contract.tasks[4]).not.toHaveProperty("exitCode");
      expect(contract.tasks[5]).toMatchObject({ exitCode: null, signal: "SIGTERM" });
    }),
  );

  it.effect("carries the domain failure cause and redacts and bounds every metadata string", () =>
    Effect.gen(function* () {
      const failed = task({
        name: `${"n".repeat(250)} token=name-secret`,
        state: "failed",
        endedAt: 2,
        exitCode: 1,
        error: `\u001b[31mspawn\u001b[0m failed api_key=error-secret ${"e".repeat(5_000)}`,
        failureCause: "FAIL auth password=cause-secret",
      });
      const result = yield* execute(
        { action: "status", id: "task-1" },
        { status: () => Effect.succeed(failed) },
      );
      const { contract } = result;
      if (contract.action !== "status") throw new Error("status returned the wrong contract");
      const json = serialize(encoded(contract));
      for (const secret of ["name-secret", "error-secret", "cause-secret", "\u001b"])
        expect(json).not.toContain(secret);
      expect(contract.task.id).toBe("task-1");
      expect(contract.task.cause).toMatch(/^FAIL auth password=/u);
      expect(contract.task.name!.length).toBeLessThanOrEqual(256);
      expect(contract.task.error!.length).toBeLessThanOrEqual(2_048);
      // Persisted details stay metadata only; the cause reaches them only as a text span.
      expect(serialize(result.details)).not.toContain("FAIL auth");
      expect(result.details).toMatchObject({ causes: [{ id: "task-1" }] });

      const blank = task({ name: "\u001b[0m  ", signal: "", error: "\t" });
      const projected = (yield* execute(
        { action: "status", id: "task-1" },
        { status: () => Effect.succeed(blank) },
      )).contract;
      if (projected.action !== "status") throw new Error("status returned the wrong contract");
      for (const key of ["name", "signal", "error", "cause"])
        expect(projected.task).not.toHaveProperty(key);
    }),
  );

  it.effect("encodes strictly into detached frozen data and leaves Code Mode v1 unchanged", () =>
    Effect.gen(function* () {
      const result = yield* execute(
        { action: "status", id: "task-1" },
        { status: () => Effect.succeed(task({ failureCause: "error: boom" })) },
      );
      const { contract } = result;
      if (contract.action !== "status") throw new Error("status returned the wrong contract");
      const json = encoded(contract);
      const nested = Predicate.hasProperty(json, "task") ? json.task : undefined;
      expect(nested).toEqual(contract.task);
      expect(nested).not.toBe(contract.task);
      expect(Object.isFrozen(json)).toBe(true);
      expect(Object.isFrozen(nested)).toBe(true);

      // Excess keys and out-of-bounds facts are producer invariant failures, never partial data.
      const withExtraKey = { ...contract, extra: true };
      const withCommand = { ...contract.task, command: "pnpm dev" };
      const invalid: ReadonlyArray<BackgroundTaskContract> = [
        withExtraKey,
        { ...contract, task: withCommand },
        { ...contract, task: { ...contract.task, startedAt: -1 } },
        { ...contract, task: { ...contract.task, exitCode: 1.5 } },
      ];
      for (const value of invalid) expect(encodeBackgroundTaskContract(value)).toBeUndefined();

      const v1 = projectBackgroundTaskCodeModeOutput(result, 1_000_000);
      if (v1._tag !== "Accepted") throw new Error("Code Mode v1 refused a small result");
      expect(Object.keys(v1.output).sort()).toEqual(["action", "snapshot", "text"]);
      expect(v1.output).toMatchObject({ snapshot: { command: "command-marker pnpm dev" } });
    }),
  );

  it.effect("returns raw sanitized combined logs clipped to the newest bytes", () =>
    Effect.gen(function* () {
      const logs = (events: ReadonlyArray<BackgroundLogEvent>, droppedBytes = 0) =>
        execute(
          { action: "logs", id: "task-1" },
          {
            logs: () =>
              Effect.succeed({
                id: "task-1",
                state: "exited",
                nextCursor: 9,
                earliestAvailableCursor: 2,
                droppedBytes,
                events,
              }),
          },
        );

      const plain = yield* logs([
        event(2, "hello \u001b[31mred\u001b[0m token=raw-output\n"),
        event(3, "boom\n", "stderr"),
      ]);
      expect(plain.contract).toMatchObject({
        action: "logs",
        state: "exited",
        finished: true,
        output: "hello red token=raw-output\n[stderr] boom\n",
        truncated: false,
        nextCursor: 9,
      });
      encoded(plain.contract);

      // Multi-byte output larger than the payload bound keeps only its newest whole characters.
      const big = `oldest-marker${"é".repeat(MAX_CONTRACT_LOG_OUTPUT_BYTES / 2)}newest-marker`;
      const clipped = yield* logs([event(7, big)]);
      if (clipped.contract.action !== "logs") throw new Error("logs returned the wrong contract");
      encoded(clipped.contract);
      const { output } = clipped.contract;
      expect(utf8ByteLength(output)).toBeLessThanOrEqual(MAX_CONTRACT_LOG_OUTPUT_BYTES);
      expect(output.endsWith("newest-marker")).toBe(true);
      expect(output).not.toContain("oldest-marker");
      // Clipping is payload-only: buffer loss stays zero and the cursor is the latest assigned.
      expect(clipped.contract).toMatchObject({ truncated: true, droppedBytes: 0, nextCursor: 9 });
      // The model-facing text keeps its own independent, smaller bound.
      expect(utf8ByteLength(clipped.text)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
      expect(clipped.details).toMatchObject({ truncation: { truncated: true } });

      const empty = yield* logs([], 512);
      expect(empty.contract).toMatchObject({ output: "", truncated: false, droppedBytes: 512 });
      encoded(empty.contract);
    }),
  );

  it.effect("reports a wait timeout as data and leaves the task running", () =>
    Effect.gen(function* () {
      const { contract } = yield* execute(
        { action: "wait", id: "task-1", until: "exit", waitSeconds: 1 },
        {
          wait: () =>
            Effect.succeed({
              id: "task-1",
              outcome: "timeout",
              snapshot: task(),
              nextCursor: 3,
              earliestAvailableCursor: 1,
              droppedBytes: 0,
            }),
        },
      );
      encoded(contract);
      expect(contract).toMatchObject({
        action: "wait",
        outcome: "timeout",
        task: { id: "task-1", state: "running", finished: false },
      });
      expect(contract).not.toHaveProperty("matchCursor");
    }),
  );
});

describe("registered background_task output", () => {
  const call = (tool: ReturnType<typeof registeredTool>, input: BackgroundTaskToolInput) =>
    Effect.promise(() => tool.execute("call", input, undefined, undefined, ctx));

  it.effect("declares the contract output schema and returns it beside unchanged text", () =>
    Effect.gen(function* () {
      const services: ServiceOverrides = {
        status: () => Effect.succeed(task({ state: "failed", exitCode: 2, failureCause: "error" })),
      };
      const tool = registeredTool(services);
      const declared = Schema.is(
        SchemaRepresentation.fromJsonSchemaDocument(
          JsonSchema.fromSchemaDraft2020_12({ ...tool.outputSchema }),
        ),
      );
      const input = { action: "status", id: "task-1" } as const;
      const direct = yield* execute(input, services);
      const result = yield* call(tool, input);
      expect(result.isError).toBeUndefined();
      expect(result.content).toEqual([{ type: "text", text: direct.text }]);
      expect(result.details).toEqual(direct.details);
      expect(decodeStrict(result.structuredContent)).toEqual(direct.contract);
      // Pi's generated declaration must independently accept the actual encoded result.
      expect(declared(result.structuredContent)).toBe(true);
    }),
  );

  it.effect("rejects typed failures without a result or contract", () =>
    Effect.promise(() =>
      expect(
        registeredTool({ status: () => Effect.fail(backgroundTaskNotFound("task-9")) }).execute(
          "call",
          { action: "status", id: "task-9" },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toMatchObject({ _tag: "BackgroundTaskNotFoundError" }),
    ),
  );

  it.effect(
    "keeps the original receipt as an error without structured data on encode failure",
    () =>
      Effect.gen(function* () {
        // A domain fact outside the contract bounds: the start already happened and is not undone.
        const services: ServiceOverrides = {
          start: () => Effect.succeed(task({ id: "task-7", startedAt: -1 })),
        };
        const input = { action: "start", command: "pnpm dev" } as const;
        const direct = yield* execute(input, services);
        const result = yield* call(registeredTool(services), input);
        expect(result.isError).toBe(true);
        expect(result).not.toHaveProperty("structuredContent");
        expect(result.details).toEqual(direct.details);
        expect(result.content).toHaveLength(1);
        const [part] = result.content;
        const text = part?.type === "text" ? part.text : "";
        const newline = text.indexOf("\n");
        expect(issueMessageStyleProblems(text.slice(0, newline))).toEqual([]);
        expect(text.slice(newline + 1)).toBe(direct.text);
        expect(direct.text).toContain("task-7");
      }),
  );
});
