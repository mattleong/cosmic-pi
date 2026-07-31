import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import {
  childToolPolicy,
  releaseChildProcess,
  requestCooperativeAbort,
  safeSubagentDirectorySegment,
} from "../src/boundary/child-process.ts";

const HERDR_AGENT_TOOL_NAMES = [
  "herdr_agent_start",
  "herdr_agent_list",
  "herdr_agent_status",
  "herdr_agent_await",
  "herdr_agent_read",
  "herdr_agent_send",
  "herdr_agent_stop",
] as const;

describe("subagent child process boundary", () => {
  it("keeps untrusted session identifiers inside one directory segment", () => {
    expect(safeSubagentDirectorySegment("session-123")).toBe("session-123");
    const escaped = safeSubagentDirectorySegment("../../../../tmp/owned");
    expect(escaped).toMatch(/^id-[a-f0-9]{32}$/);
    expect(escaped).not.toContain("/");
    expect(safeSubagentDirectorySegment("../../../../tmp/owned")).toBe(escaped);
  });

  it("passes every Herdr orchestration tool through the child --exclude-tools policy", () => {
    const policy = childToolPolicy(["read", ...HERDR_AGENT_TOOL_NAMES], "writer");
    const excluded = new Set(policy.excluded.split(","));
    expect(policy.enabled).toEqual(["read", ...HERDR_AGENT_TOOL_NAMES]);
    expect(HERDR_AGENT_TOOL_NAMES.every((name) => excluded.has(name))).toBe(true);
  });

  it.effect("bounds a cooperative abort when stdin never drains", () =>
    Effect.gen(function* () {
      const abort = yield* requestCooperativeAbort(() => Effect.never).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("250 millis");
      yield* Fiber.join(abort);
    }).pipe(Effect.scoped),
  );

  it.effect("fails closed when forced process termination cannot be confirmed", () =>
    Effect.gen(function* () {
      const modes: Array<"graceful" | "force"> = [];
      const release = yield* releaseChildProcess({
        platform: "linux",
        requestAbort: Effect.void,
        terminate: (mode) =>
          Effect.sync(() => {
            modes.push(mode);
          }),
        awaitExit: Effect.never,
      }).pipe(Effect.flip, Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("5 seconds");
      const error = yield* Fiber.join(release);

      expect(modes).toEqual(["graceful", "force"]);
      expect(error).toMatchObject({
        _tag: "SubagentProcessError",
        code: "cleanup_unconfirmed",
      });
    }).pipe(Effect.scoped),
  );
});
