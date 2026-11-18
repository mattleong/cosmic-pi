import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Fn from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { deferredPromise, step, temporaryDirectory } from "pi-cosmic-core/testing";
import { vi } from "vitest";
import {
  ChildProcess,
  type ChildLaunchRequest,
  childProcessEnvironment,
  childToolPolicy,
  requestCooperativeAbort,
  safeSubagentDirectorySegment,
} from "../src/boundary/child-process.ts";
import { InvalidSubagentRequestError } from "../src/run/errors.ts";
import {
  AGENT_TOOL_NAMES,
  NESTED_SUBAGENT_TOOL_NAMES,
  PI_FILE_MUTATION_TOOL_NAMES,
  piChildToolSnapshot,
  piRootActiveToolSnapshot,
} from "../src/run/tool-policy.ts";
import { sweepAbandonedPrivateState } from "../src/boundary/private-state.ts";
import type { ProcessTransportRuntime } from "../src/boundary/process-transport.ts";
import { rexSessionHost } from "../src/boundary/rex-session-host.ts";
import { backendLaunch } from "./fixtures/backend-launch.ts";
import { scriptedChildProcess } from "./fixtures/scripted-child-process.ts";
import { nodeFsPromises, nodePath } from "./support/node-builtins.ts";
import * as Arr from "effect/Array";
import * as Str from "effect/String";

const isMissing = (path: string) =>
  step(() =>
    nodeFsPromises.stat(path).then(
      () => false,
      (cause: unknown) => Predicate.hasProperty(cause, "code") && cause.code === "ENOENT",
    ),
  );

/** A Rex-enabled root whose Rex CLI always succeeds and shows no block in a window. */
const enabledRexHost = (insideRex: boolean) => {
  const host = rexSessionHost({
    environment: insideRex ? { REX_SESSION: "session:1", REX_BLOCK: "block:root" } : {},
    onResume: Fn.constVoid,
    rex: (_executable, args) => (args[2] === "session.list_blocks" ? '{"blocks":[]}' : "{}"),
  });
  host.setEnabled(true);
  return host;
};

/**
 * Spawns one child through the real boundary over a scripted process, then releases it, and says
 * what was started and whether its release looked for commands it detached.
 */
const spawnAndRelease = (request: ChildLaunchRequest, insideRex = true) =>
  Effect.gen(function* () {
    const scripted = scriptedChildProcess();
    let args: ReadonlyArray<string> = [];
    let packageDir: string | undefined;
    const detachedGroups = vi.fn<ProcessTransportRuntime["detachedGroups"]>(() =>
      Effect.succeed([]),
    );
    const transportRuntime: ProcessTransportRuntime = {
      spawn: (_executable, commandArgs, options) => {
        args = commandArgs ?? [];
        packageDir = options?.env?.PI_PACKAGE_DIR;
        queueMicrotask(() => scripted.child.emit("spawn"));
        return scripted.child;
      },
      terminate: () => Effect.sync(scripted.finish),
      confirmGroupExit: () => Effect.succeed(true),
      detachedGroups,
      guardGroup: () => Effect.succeed({ release: Effect.void }),
    };
    const rexHost = enabledRexHost(insideRex);
    const agentDirectory = yield* temporaryDirectory("pi-subagents-child-host-");
    const children = yield* Effect.service(ChildProcess).pipe(
      Effect.provide(ChildProcess.layer({ agentDirectory, transportRuntime, rexHost })),
    );
    const scope = yield* Scope.make();
    yield* children.spawn(request).pipe(Scope.provide(scope));
    const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);
    yield* TestClock.adjust("5 seconds");
    yield* Fiber.join(closing);
    rexHost.close();
    return {
      args,
      packageDir,
      hosted: Arr.some(args, (arg) => Fn.pipe(arg, Str.endsWith("rex-relay.mjs"))),
      lookedForDetachedCommands: detachedGroups.mock.calls.length > 0,
    };
  });

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
        "workflow",
        "workflow_control",
        "workflow_future",
        "agent_send",
        "session_list",
        "session_send",
        "session_read",
        // The main agent decides what the user is asked; a subagent asks its parent.
        "ask_user",
        "ask_user_async",
        "bash",
      ]);
      const policy = childToolPolicy(snapshot, "writer");

      expect(policy.enabled).toEqual([
        "read",
        "edit",
        "bash",
        "agent_contact_parent",
        ...NESTED_SUBAGENT_TOOL_NAMES,
        ...AGENT_TOOL_NAMES,
      ]);
      expect(Str.split(policy.excluded, ",")).toEqual([
        "workflow",
        "workflow_control",
        "session_list",
        "session_send",
        "session_read",
        "ask_user",
        "ask_user_async",
        "ask_user_async_control",
      ]);
      expect(Str.split(policy.excluded, ",")).not.toContain("agent_start");
      for (const name of AGENT_TOOL_NAMES)
        expect(Str.split(policy.excluded, ",")).not.toContain(name);
    }),
  );

  it("keeps file-mutation tools from a read-only child at every spawn, whatever its snapshot", () => {
    const snapshot = ["read", "edit", "bash", "write", "codemode"];
    const reader = childToolPolicy(snapshot, "read-only");
    expect(reader.enabled).toEqual(expect.arrayContaining(["read", "bash", "codemode"]));
    for (const name of PI_FILE_MUTATION_TOOL_NAMES) {
      expect(reader.enabled).not.toContain(name);
      // Excluded tools are never registered, so neither an extension nor codemode can reach them.
      expect(Str.split(reader.excluded, ",")).toContain(name);
    }
    const writer = childToolPolicy(snapshot, "writer");
    expect(writer.enabled).toEqual(expect.arrayContaining(snapshot));
    for (const name of PI_FILE_MUTATION_TOOL_NAMES)
      expect(Str.split(writer.excluded, ",")).not.toContain(name);
  });

  it("withholds file-mutation tools from a read-only snapshot even when an allow list names them", () => {
    const inherited = ["read", "edit", "write", "bash", "grep"];
    expect(piChildToolSnapshot(inherited, undefined, "read-only")).toEqual({
      tools: ["read", "bash", "grep"],
      withheld: [],
    });
    expect(piChildToolSnapshot(inherited, undefined, "writer").tools).toEqual(inherited);
    const allow = { allow: ["read", "edit", "write", "edit"] };
    expect(piChildToolSnapshot(inherited, allow, "read-only")).toEqual({
      tools: ["read"],
      withheld: ["edit", "write"],
    });
    expect(piChildToolSnapshot(inherited, allow, "writer")).toEqual({
      tools: ["read", "edit", "write"],
      withheld: [],
    });
    expect(piChildToolSnapshot(inherited, { deny: ["bash"] }, "read-only").tools).toEqual([
      "read",
      "grep",
    ]);
  });

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

  it.effect("keeps every writer headless while Rex hosts read-only runs", () =>
    Effect.gen(function* () {
      const reader = yield* spawnAndRelease(backendLaunch({ writeIntent: "read-only" }));
      expect(reader.hosted).toBe(true);
      expect(reader.args).not.toContain("--mode");
      expect(reader.packageDir).toBe(getPackageDir());

      const cliOnly = yield* spawnAndRelease({
        ...backendLaunch({ writeIntent: "read-only" }),
        model: "llama.cpp/local",
      });
      expect(cliOnly.hosted).toBe(false);
      expect(cliOnly.args).toEqual(
        expect.arrayContaining(["--mode", "rpc", "--model", "llama.cpp/local"]),
      );

      // With the same setting outside Rex, the CLI still owns the child and its environment.
      const outside = yield* spawnAndRelease(backendLaunch({ writeIntent: "read-only" }), false);
      expect(outside.hosted).toBe(false);
      expect(outside.args).toEqual(expect.arrayContaining(["--mode", "rpc"]));
      expect(outside.packageDir).toBe(process.env.PI_PACKAGE_DIR);

      const writers = [
        backendLaunch({ runId: "shared-writer", writeIntent: "writer" }),
        backendLaunch({ runId: "worktree-writer", writeIntent: "writer", cwd: "/tmp/worktree" }),
      ];
      for (const request of writers) {
        const writer = yield* spawnAndRelease(request);
        expect(writer.hosted).toBe(false);
        expect(writer.packageDir).toBe(process.env.PI_PACKAGE_DIR);
        expect(writer.args).toEqual(expect.arrayContaining(["--mode", "rpc"]));
        // Its release still proves no command it detached can keep changing files.
        expect(writer.lookedForDetachedCommands).toBe(true);
      }
      const resumed = yield* spawnAndRelease({
        ...backendLaunch({ runId: "resumed-writer", writeIntent: "writer" }),
        resumeSessionFile: "/tmp/session.jsonl",
      });
      expect(resumed.hosted).toBe(false);
      expect(resumed.args).toEqual(
        expect.arrayContaining(["--mode", "rpc", "--session", "/tmp/session.jsonl"]),
      );
      expect(resumed.lookedForDetachedCommands).toBe(true);
    }).pipe(Effect.scoped),
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
        yield* sweepAbandonedPrivateState(agentDirectory);
        expect(yield* isMissing(sessionDirectory)).toBe(true);
      }).pipe(Effect.scoped),
  );
});
