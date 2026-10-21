import { afterAll, describe, expect, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as os from "node:os";
import * as hookRunner from "../../src/boundary/worktree-hook.ts";
import {
  nodeFsPromises as fs,
  nodeMkdirSync,
  nodePath as path,
} from "../../src/boundary/node-builtins.ts";
import type { WorkspaceHandle } from "../../src/workspace/model.ts";
import type { WorkspaceServiceContract } from "../../src/workspace/service.ts";
import {
  exists,
  failureOf,
  io,
  readText,
  workspaceTarget,
  workspaceTests,
  writeFile,
} from "./fixtures/repository.ts";

// Hooks are fixed when the engine starts, so they log to one directory for the whole file.
// Logs name workspaces by their unique IDs, so another run's leftovers can't match.
const logs = path.join(os.tmpdir(), `pi-worktree-remove-${process.pid}`);
nodeMkdirSync(logs, { recursive: true });
afterAll(() => fs.rm(logs, { recursive: true, force: true }));
const log = path.join(logs, "remove.log");

// Logs its stdin, then fails when the tree asks it to.
const test = workspaceTests(
  [
    ["src/main.ts", "baseline\n"],
    [".gitignore", "scratch/\n"],
  ],
  [],
  {
    worktreeRemove: [
      { command: ["/bin/sh", "-c", 'cat >> "$1"; test ! -e scratch/fail-remove', "sh", log] },
    ],
  },
);

const decodeLoggedInput = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      event: Schema.String,
      workspaceId: Schema.String,
      worktreePath: Schema.String,
      sourceCwd: Schema.String,
      kind: Schema.String,
    }),
  ),
);

/** The stdin objects WorktreeRemove hooks logged for `workspaceId`, in order. */
const removals = (workspaceId: string) =>
  readText(log).pipe(
    Effect.orElseSucceed(() => ""),
    Effect.flatMap((text) =>
      Effect.forEach(text.split("\n").filter(Boolean), (line) => decodeLoggedInput(line)),
    ),
    Effect.map((inputs) => inputs.filter((input) => input.workspaceId === workspaceId)),
    Effect.orDie,
  );

const originalHook = hookRunner.runWorktreeHook;
// Every WorktreeRemove hook fails with its process cleanup unconfirmed while the spy is installed;
// WorktreeCreate hooks run as usual.
const unconfirmedRemoval = () =>
  vi.spyOn(hookRunner, "runWorktreeHook").mockImplementation((hook, input, options) =>
    input.event === "WorktreeCreate"
      ? originalHook(hook, input, options)
      : Effect.sync(() => options?.onCleanup?.(false)).pipe(
          Effect.andThen(
            Effect.fail(
              new hookRunner.WorktreeHookError({
                message: "Left processes.",
                cleanupUnconfirmed: true,
              }),
            ),
          ),
        ),
  );

const prepareEdit = (service: WorkspaceServiceContract, handle: WorkspaceHandle) =>
  Effect.gen(function* () {
    yield* writeFile(path.join(handle.cwd, "src/main.ts"), "worker\n");
    const revision = yield* service.freeze(workspaceTarget(handle));
    const prepared = yield* service.prepare({
      ...workspaceTarget(handle),
      revisionId: revision.revisionId,
    });
    return { revision, prepared };
  });

describe("WorktreeRemove hooks", () => {
  test("run in the prepared tree and then the worker before discard removes them", function* (service, root) {
    const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    const { prepared } = yield* prepareEdit(service, handle);
    yield* service.discard(workspaceTarget(handle));
    expect(yield* removals(handle.workspaceId)).toEqual([
      {
        event: "WorktreeRemove",
        workspaceId: handle.workspaceId,
        worktreePath: prepared.cwd,
        sourceCwd: root,
        kind: "prepare",
      },
      {
        event: "WorktreeRemove",
        workspaceId: handle.workspaceId,
        worktreePath: handle.cwd,
        sourceCwd: root,
        kind: "worker",
      },
    ]);
    expect(yield* exists(handle.cwd)).toBe(false);
    expect(yield* exists(prepared.cwd)).toBe(false);
  });

  test("run before integration cleans up its trees", function* (service, root) {
    const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    const { revision, prepared } = yield* prepareEdit(service, handle);
    yield* service.integrate({
      ...workspaceTarget(handle),
      revisionId: revision.revisionId,
      preparationId: prepared.preparationId,
    });
    expect((yield* removals(handle.workspaceId)).map((input) => input.kind)).toEqual([
      "prepare",
      "worker",
    ]);
    expect(yield* readText(root, "src/main.ts")).toBe("worker\n");
    expect(yield* exists(handle.cwd)).toBe(false);
  });

  test("never run in a tree create or prepare rolls back", function* (service, root) {
    const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    yield* writeFile(path.join(handle.cwd, "src/main.ts"), "worker\n");
    const revision = yield* service.freeze(workspaceTarget(handle));
    yield* writeFile(path.join(root, "src/main.ts"), "parent\n");
    yield* failureOf(
      service.prepare({ ...workspaceTarget(handle), revisionId: revision.revisionId }),
    );
    expect(yield* removals(handle.workspaceId)).toEqual([]);
  });

  test("a failing hook never blocks removal", function* (service, root) {
    const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    yield* io(() => fs.mkdir(path.join(handle.cwd, "scratch")));
    yield* writeFile(path.join(handle.cwd, "scratch/fail-remove"), "");
    yield* service.discard(workspaceTarget(handle));
    expect((yield* removals(handle.workspaceId)).map((input) => input.kind)).toEqual(["worker"]);
    expect(yield* exists(handle.cwd)).toBe(false);
    const record = (yield* service.listAll).records.find(
      (entry) => entry.handle.workspaceId === handle.workspaceId,
    );
    expect(record?.status).toBe("discarded");
    expect(record?.hookCleanupPending).toBeUndefined();
  });

  test("keep the tree and quarantine the workspace when hook cleanup is unconfirmed", function* (service, root) {
    const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    const spy = unconfirmedRemoval();
    const failure = yield* failureOf(service.discard(workspaceTarget(handle))).pipe(
      Effect.ensuring(Effect.sync(() => spy.mockRestore())),
    );
    expect(failure.cleanupUnconfirmed).toBe(true);
    expect(yield* exists(handle.cwd)).toBe(true);
    expect((yield* failureOf(service.inspect(workspaceTarget(handle)))).cleanupUnconfirmed).toBe(
      true,
    );
    expect((yield* service.listAll).records[0]?.hookCleanupPending).toBe(handle.cwd);
  });

  test("a failed WorktreeCreate hook reports the quarantine of the preparation it withdrew", function* (service, root) {
    const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    const { prepared } = yield* prepareEdit(service, handle);
    const spy = unconfirmedRemoval();
    const failure = yield* failureOf(
      service.runCreateHooks({
        ...workspaceTarget(handle),
        preparationId: prepared.preparationId,
        hooks: [{ command: ["/bin/sh", "-c", "exit 3"] }],
      }),
    ).pipe(Effect.ensuring(Effect.sync(() => spy.mockRestore())));
    expect(failure.cleanupUnconfirmed).toBe(true);
    expect(yield* exists(prepared.cwd)).toBe(true);
    expect((yield* failureOf(service.inspect(workspaceTarget(handle)))).cleanupUnconfirmed).toBe(
      true,
    );
  });

  test("a rebase fails with the quarantine its earlier test tree's hook left", function* (service, root) {
    const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    const { prepared } = yield* prepareEdit(service, handle);
    yield* writeFile(path.join(root, "src/parent.ts"), "parent\n");
    const spy = unconfirmedRemoval();
    const failure = yield* failureOf(service.rebase(workspaceTarget(handle))).pipe(
      Effect.ensuring(Effect.sync(() => spy.mockRestore())),
    );
    expect(failure.cleanupUnconfirmed).toBe(true);
    expect(yield* readText(handle.cwd, "src/parent.ts")).toBe("parent\n");
    expect(yield* exists(prepared.cwd)).toBe(true);
    expect((yield* failureOf(service.inspect(workspaceTarget(handle)))).cleanupUnconfirmed).toBe(
      true,
    );
  });
});

// The first hook can't start; the second runs until interrupted.
const interruptible = workspaceTests([["src/main.ts", "baseline\n"]], [], {
  worktreeRemove: [
    { command: ["pi-worktree-remove-missing-command"] },
    { command: ["/bin/sh", "-c", "touch hook-started; exec sleep 30"] },
  ],
});

describe("WorktreeRemove hooks after one couldn't start", () => {
  interruptible(
    "clear their marker once an interrupted later hook stops",
    function* (service, root) {
      const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
      const discarding = yield* Effect.forkChild(service.discard(workspaceTarget(handle)));
      const started = path.join(handle.cwd, "hook-started");
      for (let attempt = 0; attempt < 1_000 && !(yield* exists(started)); attempt++)
        yield* Effect.sleep("10 millis");
      expect(yield* exists(started)).toBe(true);
      yield* Fiber.interrupt(discarding);
      const record = yield* service.inspect(workspaceTarget(handle));
      expect(record.status).toBe("active");
      expect(record.hookCleanupPending).toBeUndefined();
      expect(yield* exists(handle.cwd)).toBe(true);
    },
  );
});
