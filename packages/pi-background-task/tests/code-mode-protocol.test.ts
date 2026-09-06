import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { vi } from "vitest";
import {
  BACKGROUND_TASK_CODE_MODE_BOUNDS,
  BACKGROUND_TASK_CODE_MODE_VERSION,
  BackgroundTaskCodeModeInputSchema,
  BackgroundTaskCodeModeOutputSchema,
  normalizeBackgroundTaskCodeModeCapability,
  normalizeBackgroundTaskCodeModeQuery,
} from "../src/code-mode/protocol.ts";
import { BACKGROUND_TASK_ACTIONS } from "../src/tools/schema.ts";

const snapshot = {
  id: "task-1",
  command: "node server.js",
  cwd: "/project",
  state: "running" as const,
  pid: 42,
  startedAt: 1,
  logCursor: 2,
  droppedLogBytes: 0,
};

const decodeInput = Schema.decodeUnknownEffect(BackgroundTaskCodeModeInputSchema);
const decodeOutput = Schema.decodeUnknownEffect(BackgroundTaskCodeModeOutputSchema);
describe("Background Tasks Code Mode protocol", () => {
  it.effect("normalizes checked query and execution capabilities", () =>
    Effect.gen(function* () {
      const respond = vi.fn();
      const query = normalizeBackgroundTaskCodeModeQuery({
        version: BACKGROUND_TASK_CODE_MODE_VERSION,
        sessionId: "session-1",
        respond,
      });
      expect(query?.sessionId).toBe("session-1");
      query?.respond({ ok: true });
      expect(respond).toHaveBeenCalledWith({ ok: true });

      const execute = vi.fn(() =>
        Promise.resolve({ action: "clear" as const, text: "Cleared 0", removed: 0 }),
      );
      const capability = normalizeBackgroundTaskCodeModeCapability({
        version: BACKGROUND_TASK_CODE_MODE_VERSION,
        sessionId: "session-1",
        execute,
      });
      const signal = new AbortController().signal;
      const result = yield* Effect.promise(
        () => capability?.execute("call-1", { action: "clear" }, signal, 1_024) ?? Promise.reject(),
      );
      expect(result).toMatchObject({ removed: 0 });
      expect(execute).toHaveBeenCalledWith("call-1", { action: "clear" }, signal, 1_024);
    }),
  );

  it.effect("decodes every exact v1 input and output branch at its bounds", () =>
    Effect.gen(function* () {
      const input = yield* decodeInput({
        action: "wait",
        command: "x".repeat(BACKGROUND_TASK_CODE_MODE_BOUNDS.maxCommandChars),
        cwd: "x".repeat(BACKGROUND_TASK_CODE_MODE_BOUNDS.maxPathChars),
        name: "x".repeat(BACKGROUND_TASK_CODE_MODE_BOUNDS.maxNameChars),
        id: "x".repeat(BACKGROUND_TASK_CODE_MODE_BOUNDS.maxIdChars),
        timeoutSeconds: BACKGROUND_TASK_CODE_MODE_BOUNDS.minTimeoutSeconds,
        contains: "x".repeat(BACKGROUND_TASK_CODE_MODE_BOUNDS.maxContainsChars),
        afterCursor: Number.MAX_SAFE_INTEGER,
        tailLines: BACKGROUND_TASK_CODE_MODE_BOUNDS.maxTailLines,
        waitSeconds: BACKGROUND_TASK_CODE_MODE_BOUNDS.maxWaitSeconds,
        force: false,
      });
      expect(input).toMatchObject({ action: "wait", afterCursor: Number.MAX_SAFE_INTEGER });

      const decodedInputActions: string[] = [];
      for (const action of BACKGROUND_TASK_ACTIONS) {
        decodedInputActions.push((yield* decodeInput({ action })).action);
      }
      expect(decodedInputActions).toEqual(BACKGROUND_TASK_ACTIONS);

      const outputs: ReadonlyArray<unknown> = [
        { action: "start", text: "started", snapshot },
        { action: "list", text: "listed", tasks: [snapshot] },
        { action: "status", text: "status", snapshot },
        {
          action: "logs",
          text: "logs",
          logs: {
            id: snapshot.id,
            nextCursor: 2,
            earliestAvailableCursor: 1,
            droppedBytes: 0,
            state: snapshot.state,
          },
        },
        {
          action: "wait",
          text: "waited",
          wait: {
            id: snapshot.id,
            outcome: "matched",
            snapshot,
            nextCursor: 2,
            earliestAvailableCursor: 1,
            droppedBytes: 0,
            matchCursor: 2,
          },
        },
        { action: "stop", text: "stopped", snapshot },
        { action: "stop_all", text: "stopped all", tasks: [snapshot] },
        { action: "clear", text: "cleared", removed: Number.MAX_SAFE_INTEGER },
      ];
      const decodedActions: string[] = [];
      for (const output of outputs) {
        decodedActions.push((yield* decodeOutput(output)).action);
      }
      expect(decodedActions).toEqual(BACKGROUND_TASK_ACTIONS);
    }),
  );

  it.effect("rejects invalid numerics, oversized fields, and present undefined optionals", () =>
    Effect.gen(function* () {
      const invalidInputs: ReadonlyArray<unknown> = [
        { action: "start", timeoutSeconds: 0 },
        { action: "logs", afterCursor: 0.5 },
        { action: "logs", afterCursor: Number.MAX_SAFE_INTEGER + 1 },
        { action: "logs", tailLines: BACKGROUND_TASK_CODE_MODE_BOUNDS.maxTailLines + 1 },
        { action: "wait", waitSeconds: Number.NaN },
        {
          action: "wait",
          contains: "x".repeat(BACKGROUND_TASK_CODE_MODE_BOUNDS.maxContainsChars + 1),
        },
        {
          action: "start",
          command: "x".repeat(BACKGROUND_TASK_CODE_MODE_BOUNDS.maxCommandChars + 1),
        },
        {
          action: "start",
          cwd: "x".repeat(BACKGROUND_TASK_CODE_MODE_BOUNDS.maxPathChars + 1),
        },
        {
          action: "start",
          name: "x".repeat(BACKGROUND_TASK_CODE_MODE_BOUNDS.maxNameChars + 1),
        },
        {
          action: "status",
          id: "x".repeat(BACKGROUND_TASK_CODE_MODE_BOUNDS.maxIdChars + 1),
        },
        { action: "list", state: undefined },
      ];
      for (const input of invalidInputs) {
        expect((yield* Effect.result(decodeInput(input)))._tag).toBe("Failure");
      }

      const invalidOutputs: ReadonlyArray<unknown> = [
        {
          action: "status",
          text: "x".repeat(BACKGROUND_TASK_CODE_MODE_BOUNDS.maxTextChars + 1),
          snapshot,
        },
        { action: "status", text: "bad pid", snapshot: { ...snapshot, pid: 0 } },
        { action: "status", text: "undefined", snapshot: { ...snapshot, name: undefined } },
        {
          action: "list",
          text: "too many",
          tasks: Array.from(
            { length: BACKGROUND_TASK_CODE_MODE_BOUNDS.maxSnapshots + 1 },
            () => snapshot,
          ),
        },
        {
          action: "logs",
          text: "empty id",
          logs: {
            id: "",
            nextCursor: 0,
            earliestAvailableCursor: 0,
            droppedBytes: 0,
            state: "running",
          },
        },
        { action: "clear", text: "infinite", removed: Number.POSITIVE_INFINITY },
        { action: "clear", text: "unsafe", removed: Number.MAX_SAFE_INTEGER + 1 },
      ];
      for (const output of invalidOutputs) {
        expect((yield* Effect.result(decodeOutput(output)))._tag).toBe("Failure");
      }
    }),
  );

  it.effect("contains rejecting callable thenables from response callbacks", () =>
    Effect.gen(function* () {
      const query = normalizeBackgroundTaskCodeModeQuery({
        version: BACKGROUND_TASK_CODE_MODE_VERSION,
        sessionId: "session-1",
        respond: () => {
          const rejected = Promise.reject(new Error("contained callable rejection"));
          const thenKey = ["th", "en"].join("");
          return new Proxy(() => undefined, {
            get: (_target, property) =>
              property === thenKey ? rejected.then.bind(rejected) : undefined,
          });
        },
      });
      expect(() => query?.respond({ ok: true })).not.toThrow();
      yield* Effect.promise(() => Promise.resolve());
    }),
  );

  it("rejects wrong versions, invalid session ids, non-functions, and hostile getters", () => {
    const boundarySessionId = "s".repeat(BACKGROUND_TASK_CODE_MODE_BOUNDS.maxSessionIdChars);
    const oversizedSessionId = `${boundarySessionId}s`;
    expect(
      normalizeBackgroundTaskCodeModeQuery({
        version: 1,
        sessionId: boundarySessionId,
        respond() {},
      }),
    ).toBeDefined();
    expect(
      normalizeBackgroundTaskCodeModeCapability({
        version: 1,
        sessionId: boundarySessionId,
        execute() {},
      }),
    ).toBeDefined();
    expect(
      normalizeBackgroundTaskCodeModeQuery({ version: 2, sessionId: "session-1", respond() {} }),
    ).toBeUndefined();
    expect(
      normalizeBackgroundTaskCodeModeQuery({ version: 1, sessionId: "", respond() {} }),
    ).toBeUndefined();
    expect(
      normalizeBackgroundTaskCodeModeQuery({
        version: 1,
        sessionId: oversizedSessionId,
        respond() {},
      }),
    ).toBeUndefined();
    expect(
      normalizeBackgroundTaskCodeModeCapability({
        version: 1,
        sessionId: oversizedSessionId,
        execute() {},
      }),
    ).toBeUndefined();
    expect(
      normalizeBackgroundTaskCodeModeCapability({
        version: 1,
        sessionId: "session-1",
        execute: "nope",
      }),
    ).toBeUndefined();
    expect(
      normalizeBackgroundTaskCodeModeCapability({
        version: 1,
        sessionId: "session-1",
        get execute(): never {
          throw new Error("hostile getter");
        },
      }),
    ).toBeUndefined();
  });
});
