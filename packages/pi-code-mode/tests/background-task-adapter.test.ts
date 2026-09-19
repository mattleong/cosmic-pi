import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  BACKGROUND_TASK_CODE_MODE_QUERY,
  BACKGROUND_TASK_CODE_MODE_VERSION,
  normalizeBackgroundTaskCodeModeQuery,
  type BackgroundTaskCodeModeQuery,
} from "pi-background-task/code-mode";
import { makeBackgroundTaskDispatch } from "../src/boundary/host-background-task.ts";

const eventsFor = <Candidate>(
  candidates: ReadonlyArray<Candidate>,
  onEmit?: () => void,
): ExtensionAPI["events"] => {
  const events = createEventBus();
  events.on(BACKGROUND_TASK_CODE_MODE_QUERY, (value) => {
    onEmit?.();
    const query = normalizeBackgroundTaskCodeModeQuery(value);
    if (!query) return;
    for (const candidate of candidates) query.respond(candidate);
  });
  return events;
};

const capability = <Output>(output: Output, sessionId = "session-1") => ({
  version: BACKGROUND_TASK_CODE_MODE_VERSION,
  sessionId,
  execute: () => Promise.resolve(output),
});

describe("explicit Background Tasks guest adapter", () => {
  it.effect("rejects mismatched actions while preserving settled operation certainty", () =>
    Effect.gen(function* () {
      const operations: string[] = [];
      const dispatch = makeBackgroundTaskDispatch({
        events: eventsFor([capability({ action: "clear", text: "DO-NOT-LEAK", removed: 0 })]),
        sessionId: "session-1",
        toolCallId: "outer",
        deadlineMillis: 30_000,
        maxOutputBytes: () => 1_024,
        onOperation: (_id, certainty) => operations.push(certainty),
      });
      const error = yield* dispatch({ action: "list" }).pipe(Effect.flip);
      expect(error.message).toContain("unrecognized result shape");
      expect(error.message).not.toContain("DO-NOT-LEAK");
      expect(operations.at(-1)).toBe("completed");
    }),
  );

  it.effect("closes discovery synchronously and bounds duplicate candidates", () =>
    Effect.gen(function* () {
      for (const count of [0, 1, 100]) {
        const events = createEventBus();
        let respond: BackgroundTaskCodeModeQuery["respond"] | undefined;
        let inspected = 0;
        const candidate = {
          get version() {
            inspected++;
            return BACKGROUND_TASK_CODE_MODE_VERSION;
          },
          sessionId: "session-1",
          execute: () => Promise.resolve({ action: "list", text: "ok", tasks: [] }),
        };
        events.on(BACKGROUND_TASK_CODE_MODE_QUERY, (value) => {
          const query = normalizeBackgroundTaskCodeModeQuery(value);
          if (!query) return;
          respond = query.respond;
          for (let i = 0; i < count; i++) query.respond(candidate);
        });
        const dispatch = makeBackgroundTaskDispatch({
          events,
          sessionId: "session-1",
          toolCallId: "outer",
          deadlineMillis: 30_000,
          maxOutputBytes: () => 1_024,
        });
        if (count === 1) {
          expect(yield* dispatch({ action: "list" })).toMatchObject({ action: "list", text: "ok" });
        } else {
          const error = yield* dispatch({ action: "list" }).pipe(Effect.flip);
          expect(error.message).toContain(
            count === 0 ? "Load and activate" : "multiple background-task providers",
          );
        }
        expect(inspected).toBeLessThanOrEqual(2);
        const before = inspected;
        respond?.(candidate);
        expect(inspected).toBe(before);
      }
    }),
  );
  it.effect("fails closed without a stable session id before querying", () =>
    Effect.gen(function* () {
      let emissions = 0;
      const dispatch = makeBackgroundTaskDispatch({
        events: eventsFor([], () => {
          emissions += 1;
        }),
        sessionId: undefined,
        toolCallId: "outer",
        deadlineMillis: 30_000,
        maxOutputBytes: () => 1_024,
      });
      const error = yield* dispatch({ action: "list" }).pipe(Effect.flip);
      expect(error.message).toContain("no stable id");
      expect(emissions).toBe(0);
    }),
  );

  it.effect("rejects absent, wrong-session, and ambiguous providers", () =>
    Effect.gen(function* () {
      const cases = [
        { candidates: [], expected: "Load and activate" },
        {
          candidates: [capability({ action: "list", text: "wrong", tasks: [] }, "other")],
          expected: "Load and activate",
        },
        {
          candidates: [
            capability({ action: "list", text: "one", tasks: [] }),
            capability({ action: "list", text: "two", tasks: [] }),
          ],
          expected: "multiple background-task providers",
        },
      ];
      for (const testCase of cases) {
        const dispatch = makeBackgroundTaskDispatch({
          events: eventsFor(testCase.candidates),
          deadlineMillis: 30_000,
          sessionId: "session-1",
          toolCallId: "outer",
          maxOutputBytes: () => 1_024,
        });
        const error = yield* dispatch({ action: "list" }).pipe(Effect.flip);
        expect(error.message).toContain(testCase.expected);
      }
    }),
  );

  it.effect("enforces the aggregate allowance before compact JSON allocation", () =>
    Effect.gen(function* () {
      const tasks = Array.from({ length: 10 }, (_, index) => ({
        id: `bg-${index}`,
        command: "\u0000".repeat(100),
        cwd: "/project",
        state: "exited" as const,
        startedAt: 1,
        endedAt: 2,
        exitCode: 0,
        logCursor: 0,
        droppedLogBytes: 0,
      }));
      const dispatch = makeBackgroundTaskDispatch({
        events: eventsFor([capability({ action: "list", text: "tasks", tasks })]),
        deadlineMillis: 30_000,
        sessionId: "session-1",
        toolCallId: "outer",
        maxOutputBytes: () => 1_000,
      });
      const error = yield* dispatch({ action: "list" }).pipe(Effect.flip);
      expect(error.message).toContain("beyond the current child-output allowance");
    }),
  );

  it.effect("contains hostile provider rejection coercion", () =>
    Effect.gen(function* () {
      const dispatch = makeBackgroundTaskDispatch({
        deadlineMillis: 30_000,
        events: eventsFor([
          {
            version: BACKGROUND_TASK_CODE_MODE_VERSION,
            sessionId: "session-1",
            execute: () =>
              Promise.reject({
                toString: () => {
                  throw new Error("toString escaped");
                },
              }),
          },
        ]),
        sessionId: "session-1",
        toolCallId: "outer",
        maxOutputBytes: () => 1_024,
      });
      const error = yield* dispatch({ action: "list" }).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "ToolError",
        message: "Nested tool 'session.backgroundTask' failed: Unknown rejection",
      });
    }),
  );

  it.effect("rejects malformed provider output without exposing its payload", () =>
    Effect.gen(function* () {
      const dispatch = makeBackgroundTaskDispatch({
        events: eventsFor([capability({ secret: "DO-NOT-LEAK" })]),
        deadlineMillis: 30_000,
        sessionId: "session-1",
        toolCallId: "outer",
        maxOutputBytes: () => 1_024,
      });
      const error = yield* dispatch({ action: "list" }).pipe(Effect.flip);
      expect(error.message).toContain("unrecognized result shape");
      expect(error.message).not.toContain("DO-NOT-LEAK");

      const invalidNumber = makeBackgroundTaskDispatch({
        events: eventsFor([capability({ action: "clear", text: "bad", removed: Number.NaN })]),
        deadlineMillis: 30_000,
        sessionId: "session-1",
        toolCallId: "outer",
        maxOutputBytes: () => 1_024,
      });
      const numericError = yield* invalidNumber({ action: "clear" }).pipe(Effect.flip);
      expect(numericError.message).toContain("unrecognized result shape");
    }),
  );
});
