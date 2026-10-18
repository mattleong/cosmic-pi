import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import {
  childProcessEnvironment,
  childToolPolicy,
  requestCooperativeAbort,
  safeSubagentDirectorySegment,
} from "../src/boundary/child-process.ts";
import { InvalidSubagentRequestError } from "../src/run/errors.ts";
import {
  AGENT_TOOL_NAMES,
  NESTED_SUBAGENT_TOOL_NAMES,
  piRootActiveToolSnapshot,
} from "../src/run/tool-policy.ts";
import { backendLaunch } from "./fixtures/backend-supervisor.ts";

describe("subagent child process boundary", () => {
  it("keeps a child's Git on its own repository when the parent runs under Git variables", () => {
    const environment = childProcessEnvironment(
      {
        PATH: "/usr/bin",
        GIT_DIR: "/parent/.git",
        GIT_WORK_TREE: "/parent",
        GIT_INDEX_FILE: "/parent/.git/index",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.hooksPath",
        GIT_CONFIG_VALUE_0: "/parent/hooks",
        GIT_AUTHOR_NAME: "Parent Author",
      },
      backendLaunch({ runId: "agent-1" }),
    );
    expect(environment).toMatchObject({
      PATH: "/usr/bin",
      GIT_AUTHOR_NAME: "Parent Author",
      PI_SUBAGENT_RUN_ID: "agent-1",
    });
    for (const key of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
    ])
      expect(environment[key]).toBeUndefined();
  });

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
        "agent_start",
        "herdr_agent_start",
        "herdr_agent_future",
        "workflow",
        "workflow_control",
        "workflow_future",
        "agent_send",
        "session_list",
        "session_send",
        "session_read",
        "bash",
      ]);
      const policy = childToolPolicy(snapshot);

      expect(policy.enabled).toEqual([
        "read",
        "edit",
        "bash",
        "agent_contact_parent",
        ...NESTED_SUBAGENT_TOOL_NAMES,
        ...AGENT_TOOL_NAMES,
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
        "session_list",
        "session_send",
        "session_read",
      ]);
      expect(policy.excluded.split(",")).not.toContain("agent_start");
      for (const name of AGENT_TOOL_NAMES) expect(policy.excluded.split(",")).not.toContain(name);
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
        expect(error).toBeInstanceOf(InvalidSubagentRequestError);
        expect(error).toMatchObject({
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
});
