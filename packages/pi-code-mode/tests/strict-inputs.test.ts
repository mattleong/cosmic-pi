// Guest tool inputs are closed: an unknown key refuses before any native or companion dispatch
// instead of being silently stripped into a different operation.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  BACKGROUND_TASK_CODE_MODE_QUERY,
  type BackgroundTaskCodeModeInput,
} from "pi-background-task/code-mode";
import type { McpCodeModeInput } from "pi-mcp/code-mode";
import type {
  NestedPiToolDefinitions,
  PiGuestToolInput,
  PiGuestToolName,
} from "../src/boundary/host-builtin-tools.ts";
import { executeHarness, type ExecuteHarnessOptions } from "./support/execute.ts";
import { backgroundTaskProvider, mcpProvider } from "./support/providers.ts";
import { nestedToolDefinitionsFixture } from "./support/tools.ts";

interface NativeCall {
  readonly name: PiGuestToolName;
  readonly input: PiGuestToolInput;
}

/** Every built-in, including Windows-only PowerShell, recording each native dispatch. */
const recordingDefinitions = (calls: NativeCall[]): NestedPiToolDefinitions => {
  const definition = (name: PiGuestToolName) => ({
    execute: (_id: string, input: PiGuestToolInput) => {
      calls.push({ name, input });
      return Promise.resolve({
        content: [{ type: "text", text: `${name} ok` }],
        details: undefined,
      });
    },
  });
  return nestedToolDefinitionsFixture({
    read: definition("read"),
    bash: definition("bash"),
    powershell: definition("powershell"),
    edit: definition("edit"),
    write: definition("write"),
    grep: definition("grep"),
    find: definition("find"),
    ls: definition("ls"),
  });
};

/** Guest source for one awaited call; inputs are test-controlled literals. */
const guestCall = <Input>(leaf: string, input: Input) =>
  `await tools.${leaf}(${JSON.stringify(input)})`;

/** A guest program that returns the caught refusal message, or "sent" when the call ran. */
const attempt = <Input>(leaf: string, input: Input) => `
  try {
    ${guestCall(leaf, input)};
    return "sent";
  } catch (error) {
    return error.message;
  }
`;

const runGuest = (options: ExecuteHarnessOptions, code: string) =>
  Effect.gen(function* () {
    const harness = executeHarness({ cwd: "/project", ...options });
    yield* Effect.promise(() => harness.run(code));
    return harness.guestValue();
  });

describe("closed guest tool inputs", () => {
  it.effect.each([
    {
      tool: "read",
      input: { path: "example.txt", requireCompleteness: true },
      key: "requireCompleteness",
    },
    { tool: "bash", input: { command: "printf safe", cwd: "packages/web" }, key: "cwd" },
    {
      tool: "powershell",
      input: { command: "Write-Output safe", cwd: "packages/web" },
      key: "cwd",
    },
    {
      tool: "edit",
      input: { path: "example.txt", edits: [{ oldText: "old", newText: "new" }], replaceAll: true },
      key: "replaceAll",
    },
    { tool: "write", input: { path: "example.txt", content: "new", append: true }, key: "append" },
    { tool: "grep", input: { pattern: "TODO", path: "src", multiline: true }, key: "multiline" },
    { tool: "find", input: { pattern: "*.ts", hidden: true }, key: "hidden" },
    { tool: "ls", input: { path: ".", all: true }, key: "all" },
  ])("refuses unknown $tool key $key without native dispatch", ({ tool, input, key }) =>
    Effect.gen(function* () {
      const calls: NativeCall[] = [];
      const refusal = yield* runGuest(
        { definitions: recordingDefinitions(calls) },
        attempt(`pi.${tool}`, input),
      );
      expect(refusal).toEqual(expect.stringContaining(key));
      expect(refusal).not.toBe("sent");
      expect(calls).toEqual([]);
    }),
  );

  it.effect("refuses an unknown key inside one edits entry without editing", () =>
    Effect.gen(function* () {
      const calls: NativeCall[] = [];
      const refusal = yield* runGuest(
        { definitions: recordingDefinitions(calls) },
        attempt("pi.edit", {
          path: "example.txt",
          edits: [
            { oldText: "first", newText: "one" },
            { oldText: "second", newText: "two", replaceAll: true },
          ],
        }),
      );
      expect(refusal).toEqual(expect.stringMatching(/edits.*1.*replaceAll/s));
      expect(calls).toEqual([]);
    }),
  );

  it.effect("dispatches exactly valid built-in calls with every known option", () =>
    Effect.gen(function* () {
      const calls: NativeCall[] = [];
      const valid: ReadonlyArray<readonly [PiGuestToolName, object]> = [
        ["bash", { command: "printf safe", timeout: 1.5 }],
        ["powershell", { command: "Write-Output safe", timeout: 2 }],
        ["edit", { path: "example.txt", edits: [{ oldText: "old", newText: "new" }] }],
        ["write", { path: "example.txt", content: "new" }],
        [
          "grep",
          {
            pattern: "TODO",
            path: "src",
            glob: "*.ts",
            ignoreCase: true,
            literal: true,
            context: 0,
            limit: 5,
          },
        ],
        ["find", { pattern: "*.ts", path: "src", limit: 5 }],
        ["ls", { path: ".", limit: 5 }],
      ];
      const code = [
        ...valid.map(([tool, input]) => `${guestCall(`pi.${tool}`, input)};`),
        `const structured = await tools.pi.read({ path: "example.txt", offset: 1, format: "structured", requireComplete: true });`,
        `await tools.pi.read({ path: "example.txt", offset: 2, limit: 3, format: "text" });`,
        `return structured.completeness;`,
      ].join("\n");
      const value = yield* runGuest({ definitions: recordingDefinitions(calls) }, code);
      expect(value).toBe("complete");
      expect(calls).toEqual([
        ...valid.map(([name, input]) => ({ name, input })),
        // Read consumes its Code Mode-only options before the native call.
        { name: "read", input: { path: "example.txt", offset: 1 } },
        { name: "read", input: { path: "example.txt", offset: 2, limit: 3 } },
      ]);
    }),
  );

  it.effect("lets a program catch a refusal and continue without the refused mutation", () =>
    Effect.gen(function* () {
      const calls: NativeCall[] = [];
      const value = yield* runGuest(
        { definitions: recordingDefinitions(calls) },
        `
          let refused = "sent";
          try {
            await tools.pi.write({ path: "example.txt", content: "new", append: true });
          } catch (error) {
            refused = error.message;
          }
          const written = await tools.pi.write({ path: "example.txt", content: "new" });
          return { refused, written };
        `,
      );
      expect(value).toEqual({ refused: expect.stringContaining("append"), written: "write ok" });
      expect(calls).toEqual([{ name: "write", input: { path: "example.txt", content: "new" } }]);
    }),
  );

  it.effect.each([
    { input: { action: "start", command: "pnpm dev", env: { PORT: "3000" } }, key: "env" },
    { input: { action: "stop", id: "bg-1", signal: "SIGKILL" }, key: "signal" },
    { input: { action: "wait", id: "bg-1", until: "exit", timeout: 5 }, key: "timeout" },
  ])("refuses unknown Background Tasks key $key before provider discovery", ({ input, key }) =>
    Effect.gen(function* () {
      let queries = 0;
      const dispatched: unknown[] = [];
      const events = backgroundTaskProvider((_id, received) => {
        dispatched.push(received);
        return Promise.reject(new Error("unexpected dispatch"));
      });
      events.on(BACKGROUND_TASK_CODE_MODE_QUERY, () => {
        queries += 1;
      });
      const refusal = yield* runGuest({ events }, attempt("session.backgroundTask", input));
      expect(refusal).toEqual(expect.stringContaining(key));
      expect(refusal).not.toBe("sent");
      expect(queries).toBe(0);
      expect(dispatched).toEqual([]);
    }),
  );

  it.effect("dispatches exactly a valid Background Tasks call with its known options", () =>
    Effect.gen(function* () {
      const dispatched: BackgroundTaskCodeModeInput[] = [];
      const input = {
        action: "start",
        command: "dev-server",
        cwd: "/project",
        name: "dev",
        timeoutSeconds: 60,
      } as const;
      const events = backgroundTaskProvider((_id, received) => {
        dispatched.push(received);
        return Promise.resolve({
          action: "start",
          text: "Started bg-1",
          snapshot: {
            id: "bg-1",
            command: "dev-server",
            cwd: "/project",
            state: "running",
            pid: 42,
            startedAt: 1,
            logCursor: 0,
            droppedLogBytes: 0,
          },
        });
      });
      const value = yield* runGuest(
        { events },
        `return (${guestCall("session.backgroundTask", input)}).snapshot.id;`,
      );
      expect(value).toBe("bg-1");
      expect(dispatched).toEqual([input]);
    }),
  );

  it.effect("keeps MCP not-sent repair guidance for unknown keys", () =>
    Effect.gen(function* () {
      const dispatched: McpCodeModeInput[] = [];
      const events = mcpProvider((_id, received) => {
        dispatched.push(received);
        return Promise.resolve({
          action: "status",
          outcome: "completed",
          isError: false,
          data: null,
          notices: [],
        });
      });
      const value = yield* runGuest(
        { events },
        `
          let refused = "sent";
          try {
            await tools.mcp.request({ action: "status", verbose: true });
          } catch (error) {
            refused = error.message;
          }
          const status = await tools.mcp.request({ action: "status" });
          return { refused, outcome: status.outcome };
        `,
      );
      expect(value).toEqual({ refused: expect.stringContaining("not-sent"), outcome: "completed" });
      expect(dispatched).toEqual([{ action: "status" }]);
    }),
  );
});
