import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Fn from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as TestClock from "effect/testing/TestClock";
import { deferredPromise, step, temporaryDirectory } from "pi-cosmic-core/testing";
import { vi } from "vitest";
import {
  ChildProcess,
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
import { sweepAbandonedPrivateState } from "../src/boundary/private-state.ts";
import { backendLaunch } from "./fixtures/backend-supervisor.ts";
import { nodeFsPromises, nodePath } from "./support/node-builtins.ts";
import * as Str from "effect/String";

const isMissing = (path: string) =>
  step(() =>
    nodeFsPromises.stat(path).then(
      () => false,
      (cause: unknown) => Predicate.hasProperty(cause, "code") && cause.code === "ENOENT",
    ),
  );

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
      expect(Str.split(policy.excluded, ",")).toEqual([
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
      expect(Str.split(policy.excluded, ",")).not.toContain("agent_start");
      for (const name of AGENT_TOOL_NAMES)
        expect(Str.split(policy.excluded, ",")).not.toContain(name);
    }),
  );

  it.effect("rejects root tool snapshots that cannot round-trip through Pi CLI arguments", () =>
    Effect.gen(function* () {
      const aggregateOverflow = Array.from(
        { length: 256 },
        (_, index) =>
          `t${Fn.pipe(index.toString(), Str.padStart(3, "0"))}_${Fn.pipe("x", Str.repeat(123))}`,
      );
      const cases: ReadonlyArray<ReadonlyArray<string>> = [
        ["safe,workflow_future"],
        [" leading-space"],
        ["trailing-space "],
        ["line\nbreak"],
        [""],
        [Fn.pipe("x", Str.repeat(129))],
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

  it.live(
    "removes a run directory whose creation settles after an interrupted spawn's reclaim",
    () =>
      Effect.gen(function* () {
        const agentDirectory = yield* temporaryDirectory("pi-subagents-child-late-mkdir-");
        const request = backendLaunch({ parentSessionId: "late-mkdir-session", runId: "late-run" });
        const sessionDirectory = nodePath.join(agentDirectory, "subagents", "late-mkdir-session");
        const isRunDirectory = (path: string) => nodePath.dirname(path) === sessionDirectory;
        const mkdirEntered = yield* Deferred.make<string>();
        const mkdirGate = deferredPromise();
        const lateCleanup = yield* Deferred.make<void>();
        let released = false;
        const createDirectory = nodeFsPromises.mkdir;
        const removeDirectory = nodeFsPromises.rmdir;
        const gatedMkdir = vi.spyOn(nodeFsPromises, "mkdir").mockImplementation((path, options) => {
          if (!Predicate.isString(path) || !isRunDirectory(path))
            return createDirectory(path, options);
          Deferred.doneUnsafe(mkdirEntered, Effect.succeed(path));
          return mkdirGate.promise.then(() => createDirectory(path, options));
        });
        const observedRmdir = vi
          .spyOn(nodeFsPromises, "rmdir")
          .mockImplementation((path, options) =>
            removeDirectory(path, options).finally(() => {
              if (released && Predicate.isString(path) && isRunDirectory(path))
                Deferred.doneUnsafe(lateCleanup, Effect.void);
            }),
          );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            gatedMkdir.mockRestore();
            observedRmdir.mockRestore();
          }),
        );
        const children = yield* Effect.service(ChildProcess).pipe(
          Effect.provide(ChildProcess.layer({ agentDirectory })),
        );
        const spawning = yield* children.spawn(request).pipe(Effect.scoped, Effect.forkChild);

        const runDirectory = yield* Deferred.await(mkdirEntered).pipe(Effect.timeout("5 seconds"));
        // The creation is still gated, so only an interruptible spawn lets this return.
        yield* Fiber.interrupt(spawning).pipe(Effect.timeout("5 seconds"));
        expect(Exit.hasInterrupts(yield* Fiber.await(spawning))).toBe(true);
        yield* children.reclaimRunState(request);

        released = true;
        mkdirGate.resolve();
        yield* Deferred.await(lateCleanup).pipe(Effect.timeout("5 seconds"));
        expect(yield* isMissing(runDirectory)).toBe(true);
        // The shared session directory is left to the startup sweep, which removes it once empty.
        yield* sweepAbandonedPrivateState(agentDirectory, {
          claudeTemporaryParent: yield* temporaryDirectory("pi-subagents-child-late-claude-"),
        });
        expect(yield* isMissing(sessionDirectory)).toBe(true);
      }).pipe(Effect.scoped),
  );
});
