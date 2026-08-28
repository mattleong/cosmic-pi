import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vitest";
import {
  BACKGROUND_TASK_CODE_MODE_VERSION,
  normalizeBackgroundTaskCodeModeCapability,
  normalizeBackgroundTaskCodeModeQuery,
} from "../src/code-mode/protocol.ts";

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

  it("rejects wrong versions, empty session ids, non-functions, and hostile getters", () => {
    expect(
      normalizeBackgroundTaskCodeModeQuery({ version: 2, sessionId: "session-1", respond() {} }),
    ).toBeUndefined();
    expect(
      normalizeBackgroundTaskCodeModeQuery({ version: 1, sessionId: "", respond() {} }),
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
