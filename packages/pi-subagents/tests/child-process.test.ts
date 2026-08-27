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
import { piRootActiveToolSnapshot, SUBAGENT_TOOL_NAMES } from "../src/run/tool-policy.ts";

describe("subagent child process boundary", () => {
  it("keeps untrusted session identifiers inside one directory segment", () => {
    expect(safeSubagentDirectorySegment("session-123")).toBe("session-123");
    const escaped = safeSubagentDirectorySegment("../../../../tmp/owned");
    expect(escaped).toMatch(/^id-[a-f0-9]{32}$/);
    expect(escaped).not.toContain("/");
    expect(safeSubagentDirectorySegment("../../../../tmp/owned")).toBe(escaped);
  });

  it.effect("inherits ordered root tools through private proxies while excluding competitors", () =>
    Effect.gen(function* () {
      const snapshot = yield* piRootActiveToolSnapshot([
        "read",
        "edit",
        "read",
        "subagent_start",
        "subagent_future",
        "herdr_agent_start",
        "herdr_agent_future",
        "workflow",
        "workflow_control",
        "workflow_future",
        "bash",
      ]);
      const policy = childToolPolicy(snapshot);

      expect(policy.enabled).toEqual([
        "read",
        "edit",
        "bash",
        "contact_parent",
        ...SUBAGENT_TOOL_NAMES,
      ]);
      expect(policy.excluded.split(",")).toEqual([
        "herdr_agent_start",
        "herdr_agent_list",
        "herdr_agent_status",
        "herdr_agent_await",
        "herdr_agent_read",
        "herdr_agent_send",
        "herdr_agent_stop",
        "workflow",
        "workflow_control",
      ]);
      expect(policy.excluded).not.toContain("subagent_");
    }),
  );

  it.effect("rejects root tool snapshots that cannot round-trip through Pi CLI arguments", () =>
    Effect.gen(function* () {
      const aggregateOverflow = Array.from(
        { length: 256 },
        (_, index) => `t${index.toString().padStart(3, "0")}_${"x".repeat(123)}`,
      );
      const cases: ReadonlyArray<ReadonlyArray<string>> = [
        ["safe,workflow_future"],
        [" leading-space"],
        ["trailing-space "],
        ["line\nbreak"],
        [""],
        ["x".repeat(129)],
        Array.from({ length: 257 }, () => "read"),
        aggregateOverflow,
      ];
      for (const activeTools of cases) {
        const error = yield* piRootActiveToolSnapshot(activeTools).pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "InvalidSubagentRequestError",
          code: "pi_active_tools_unrepresentable",
        });
      }
    }),
  );

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
