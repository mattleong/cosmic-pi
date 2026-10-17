import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as JsonSchema from "effect/JsonSchema";
import * as SchemaRepresentation from "effect/SchemaRepresentation";
import * as Schema from "effect/Schema";
import {
  applyPresentationSettings,
  captureRegistrations,
  issueMessageStyleProblems,
} from "pi-code-previews/testing";
import { extensionContextFixture, toolSchemaPortabilityProblems } from "pi-cosmic-core/testing";
import { afterEach } from "vitest";
import type { BackgroundLogEvent, BackgroundTaskStatus } from "../src/task/model.ts";
import type { BackgroundTaskServiceContract } from "../src/task/service.ts";
import { utf8ByteLength } from "pi-cosmic-core";
import { registerBackgroundTaskTool } from "../src/tools/background-task.ts";
import { executeBackgroundTaskCommand } from "../src/tools/command.ts";
import {
  BackgroundTaskContractSchema,
  encodeBackgroundTaskContract,
  type BackgroundTaskContract,
} from "../src/tools/contract-schema.ts";
import type { BackgroundTaskToolInput } from "../src/tools/schema.ts";
import {
  provideTaskService,
  taskServiceDouble,
  taskServiceRunner,
  taskWait,
} from "./support/task-service-double.ts";

const restoreSettings = applyPresentationSettings({});
afterEach(restoreSettings);

type ServiceOverrides = Partial<BackgroundTaskServiceContract>;

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
    provideTaskService(taskServiceDouble(overrides)),
  );

const serialize = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeStrict = Schema.decodeUnknownSync(Schema.toCodecJson(BackgroundTaskContractSchema), {
  onExcessProperty: "error",
});

const encoded = (contract: BackgroundTaskContract) => {
  const json = encodeBackgroundTaskContract(contract);
  expect(json).toBeDefined();
  expect(decodeStrict(json)).toEqual(contract);
  return json;
};

const registeredTool = (overrides: ServiceOverrides) =>
  captureRegistrations((pi) =>
    registerBackgroundTaskTool(pi, { run: taskServiceRunner(taskServiceDouble(overrides)) }),
  ).tools[0]!;
const ctx = extensionContextFixture({ cwd: "/project" });

describe("background_task parameters", () => {
  it("declare only provider-portable schema keywords", () => {
    expect(toolSchemaPortabilityProblems(registeredTool({}).parameters)).toEqual([]);
  });
});

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
          Effect.succeed(
            taskWait(task(), "matched", {
              nextCursor: 4,
              earliestAvailableCursor: 2,
              matchCursor: 2,
            }),
          ),
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
      expect(declared(result.structuredContent)).toBe(true);
    }),
  );

  it.effect(
    "keeps the original receipt as an error without structured data on encode failure",
    () =>
      Effect.gen(function* () {
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
